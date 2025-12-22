import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { resumeText, fileName } = await req.json();

    if (!resumeText) {
      throw new Error("Resume text is required");
    }

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const systemPrompt = `You are an expert resume parser. Extract structured information from resumes accurately.
Always respond with valid JSON only, no markdown or explanations.`;

    const userPrompt = `Extract the following information from this resume and return as JSON:

{
  "candidate_name": "Full name",
  "candidate_email": "Email address or null",
  "candidate_phone": "Phone number or null",
  "candidate_location": "City, State/Country or null",
  "candidate_linkedin": "LinkedIn URL or null",
  "current_title": "Most recent job title",
  "current_company": "Most recent company name or null",
  "years_of_experience": number (estimate from work history),
  "experience_level": "Entry" | "Junior" | "Mid" | "Senior" | "Lead" | "Executive",
  "skills": [
    { "name": "Skill name", "proficiency": "Beginner" | "Intermediate" | "Advanced" | "Expert" }
  ],
  "education": [
    { "degree": "Degree name", "institution": "School name", "year": number or null, "field": "Field of study" }
  ],
  "certifications": [
    { "name": "Certification name", "issuer": "Issuing org", "year": number or null }
  ],
  "work_history": [
    { 
      "title": "Job title", 
      "company": "Company name", 
      "start": "YYYY-MM or YYYY", 
      "end": "YYYY-MM or Present",
      "description": "Brief description",
      "achievements": ["Achievement 1", "Achievement 2"]
    }
  ],
  "professional_summary": "2-3 sentence summary of the candidate"
}

Resume content:
${resumeText}

File name: ${fileName}

Return ONLY valid JSON, no other text.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 4096,
      messages: [
        { role: "user", content: userPrompt }
      ],
      system: systemPrompt,
    });

    // Extract text content
    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    // Parse JSON response
    let extractedData;
    try {
      // Try to parse, handling potential markdown code blocks
      let jsonText = content.text.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }
      extractedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("Failed to parse response:", content.text);
      throw new Error("Failed to parse AI response as JSON");
    }

    // Add confidence score based on completeness
    const fields = ["candidate_name", "candidate_email", "current_title", "skills", "work_history"];
    const filledFields = fields.filter(f => {
      const val = extractedData[f];
      return val && (Array.isArray(val) ? val.length > 0 : true);
    });
    extractedData.extraction_confidence = Number((filledFields.length / fields.length).toFixed(2));

    return new Response(JSON.stringify(extractedData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});