import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { jobDescription, jobUrl, platform } = await req.json();

    if (!jobDescription && !jobUrl) {
      throw new Error("Job description or URL is required");
    }

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const systemPrompt = `You are an expert job posting analyzer. Extract structured information from job descriptions accurately.
Always respond with valid JSON only, no markdown or explanations.`;

    const userPrompt = `Extract the following information from this job posting and return as JSON:

{
  "platform": "${platform || 'Unknown'}" (or detect from URL/content: LinkedIn, Indeed, Glassdoor, Dice, Greenhouse, Lever, Company Website, Other),
  "job_title": "Exact job title",
  "company_name": "Company name",
  "company_website": "Company website URL or null",
  "company_size": "Startup" | "Small" | "Medium" | "Large" | "Enterprise" or null,
  "company_industry": "Industry name or null",
  "location": "Full location string",
  "city": "City name or null",
  "state": "State/Province or null", 
  "country": "Country or null",
  "is_remote": boolean,
  "work_type": "Remote" | "Hybrid" | "Onsite" | "Flexible",
  "employment_type": "Full-time" | "Part-time" | "Contract" | "Freelance" | "Internship",
  "experience_level": "Entry" | "Junior" | "Mid" | "Senior" | "Lead" | "Executive",
  "years_experience_required": "X+ years" or "X-Y years" or null,
  "salary_raw": "Original salary text or null",
  "salary_min": number or null,
  "salary_max": number or null,
  "salary_currency": "USD" | "EUR" | "GBP" etc,
  "salary_period": "Yearly" | "Monthly" | "Hourly" or null,
  "has_bonus": boolean or null,
  "has_equity": boolean or null,
  "required_skills": [
    { "skill": "Skill name", "importance": "Required" | "Preferred" }
  ],
  "required_education": "Degree requirement or null",
  "required_certifications": ["Cert 1", "Cert 2"] or null,
  "benefits": [
    { "category": "Health" | "Financial" | "PTO" | "Perks" | "Other", "items": ["Benefit 1", "Benefit 2"] }
  ],
  "description_summary": "2-3 sentence summary of the role",
  "responsibilities": ["Responsibility 1", "Responsibility 2"],
  "qualifications": ["Qualification 1", "Qualification 2"],
  "visa_sponsorship": boolean or null,
  "easy_apply": boolean (if mentioned)
}

Job URL: ${jobUrl || 'Not provided'}
Platform hint: ${platform || 'Unknown'}

Job Description:
${jobDescription || 'No description provided - extract from URL context if possible'}

Return ONLY valid JSON, no other text.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 4096,
      messages: [
        { role: "user", content: userPrompt }
      ],
      system: systemPrompt,
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    let extractedData;
    try {
      let jsonText = content.text.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }
      extractedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("Failed to parse response:", content.text);
      throw new Error("Failed to parse AI response as JSON");
    }

    // Add confidence score
    const fields = ["job_title", "company_name", "location", "required_skills", "employment_type"];
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