import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { fileUrl, fileName } = await req.json();

    if (!fileUrl) {
      return new Response(
        JSON.stringify({ error: 'fileUrl is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Processing file:', fileName);
    console.log('File URL:', fileUrl);

    // Get file extension
    const extension = fileName?.split('.').pop()?.toLowerCase() ||
      fileUrl.split('.').pop()?.split('?')[0]?.toLowerCase();

    // Fetch the file
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch file: ${fileResponse.status}`);
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    let messages: any[];

    if (extension === 'pdf') {
      // For PDF: Use Claude's native document support
      const fileBuffer = await fileResponse.arrayBuffer();
      const base64 = base64Encode(new Uint8Array(fileBuffer));

      messages = [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            },
            {
              type: 'text',
              text: getExtractionPrompt(),
            },
          ],
        },
      ];
    } else if (extension === 'docx') {
      // For DOCX: Extract text first, then send to Claude
      const fileBuffer = await fileResponse.arrayBuffer();
      const textContent = extractTextFromDocx(fileBuffer);

      messages = [
        {
          role: 'user',
          content: `${getExtractionPrompt()}\n\nResume content:\n${textContent}`,
        },
      ];
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported file type: ${extension}. Please use PDF or DOCX.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Calling Claude API...');

    // Call Claude API
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: messages,
      }),
    });

    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text();
      console.error('Claude API error:', errorText);
      throw new Error(`Claude API error: ${claudeResponse.status}`);
    }

    const claudeData = await claudeResponse.json();
    console.log('Claude response received');

    // Extract text content from Claude's response
    const textContent = claudeData.content
      ?.filter((block: any) => block.type === 'text')
      ?.map((block: any) => block.text)
      ?.join('\n') || '';

    // Parse the JSON from Claude's response
    const extractedData = parseClaudeResponse(textContent);

    console.log('Extraction complete');

    return new Response(
      JSON.stringify(extractedData),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error:', error.message);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function getExtractionPrompt(): string {
  return `Extract the following information from this resume and return it as a JSON object. Be thorough and accurate.

Return ONLY a valid JSON object with these fields (use null for missing data):

{
  "candidate_name": "Full name",
  "candidate_email": "Email address",
  "candidate_phone": "Phone number",
  "candidate_location": "City, State/Country",
  "current_title": "Most recent job title",
  "current_company": "Most recent company",
  "years_of_experience": number or null,
  "experience_level": "Entry" | "Mid" | "Senior" | "Lead" | "Executive",
  "summary": "Professional summary or objective",
  "skills": [
    { "name": "Skill name", "proficiency": "Expert" | "Advanced" | "Intermediate" | "Beginner", "years": number or null }
  ],
  "education": [
    { "degree": "Degree name", "institution": "School name", "year": "Graduation year", "field": "Field of study" }
  ],
  "work_history": [
    { "title": "Job title", "company": "Company name", "start": "Start date", "end": "End date or Present", "description": "Brief description" }
  ],
  "certifications": ["Certification 1", "Certification 2"],
  "languages": ["Language 1", "Language 2"],
  "extraction_confidence": number between 0 and 100
}

Important:
- Return ONLY the JSON object, no markdown, no explanation
- Use null for any field you cannot find
- Be accurate with dates and numbers
- Extract ALL skills mentioned`;
}

function parseClaudeResponse(text: string): any {
  try {
    // Try to find JSON in the response
    let jsonStr = text.trim();

    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }

    jsonStr = jsonStr.trim();

    // Try to parse
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse Claude response:', e);
    // Return a minimal valid response
    return {
      extraction_status: 'partial',
      extraction_confidence: 30,
      raw_text: text.slice(0, 500)
    };
  }
}

function extractTextFromDocx(arrayBuffer: ArrayBuffer): string {
  // Simple DOCX text extraction
  // DOCX files are ZIP archives containing XML
  try {
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert to string and look for text content
    // Process in chunks to avoid stack overflow
    let content = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, Math.min(i + chunkSize, uint8Array.length));
      content += String.fromCharCode.apply(null, Array.from(chunk));
    }

    // Extract text between XML tags (simplified)
    const textMatches = content.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const extractedText = textMatches
      .map(match => {
        const textMatch = match.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
        return textMatch ? textMatch[1] : '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (extractedText.length > 100) {
      return extractedText;
    }

    // Fallback: just return what we can decode
    return content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);

  } catch (e) {
    console.error('DOCX extraction error:', e);
    return 'Unable to extract text from DOCX file';
  }
}