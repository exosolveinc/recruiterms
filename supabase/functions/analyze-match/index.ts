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
    const { resume, job } = await req.json();

    if (!resume || !job) {
      throw new Error("Resume and job data are required");
    }

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const systemPrompt = `You are an expert career advisor and recruiter. Analyze the match between a candidate's resume and a job posting.
Be honest but constructive. Always respond with valid JSON only.`;

    const userPrompt = `Analyze how well this candidate matches the job and return as JSON:

{
  "match_score": number (0-100, be realistic),
  "matching_skills": ["skill1", "skill2"],
  "missing_skills": ["skill1", "skill2"],
  "experience_match": {
    "score": number (0-100),
    "details": "Explanation of experience match"
  },
  "education_match": {
    "score": number (0-100),
    "details": "Explanation of education match"
  },
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2",
    "Specific actionable recommendation 3"
  ],
  "strengths": ["Strength 1", "Strength 2"],
  "concerns": ["Potential concern 1", "Potential concern 2"],
  "interview_tips": ["Tip 1", "Tip 2"],
  "overall_assessment": "2-3 sentence summary of the match"
}

CANDIDATE RESUME:
- Name: ${resume.candidate_name || 'Unknown'}
- Current Title: ${resume.current_title || 'Unknown'}
- Years of Experience: ${resume.years_of_experience || 'Unknown'}
- Experience Level: ${resume.experience_level || 'Unknown'}
- Skills: ${JSON.stringify(resume.skills || [])}
- Education: ${JSON.stringify(resume.education || [])}
- Work History: ${JSON.stringify(resume.work_history || [])}

JOB POSTING:
- Title: ${job.job_title || 'Unknown'}
- Company: ${job.company_name || 'Unknown'}
- Experience Required: ${job.years_experience_required || job.experience_level || 'Unknown'}
- Required Skills: ${JSON.stringify(job.required_skills || [])}
- Required Education: ${job.required_education || 'Not specified'}
- Location: ${job.location || 'Unknown'} (${job.work_type || 'Unknown'})

Return ONLY valid JSON, no other text.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 2048,
      messages: [
        { role: "user", content: userPrompt }
      ],
      system: systemPrompt,
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    let analysisData;
    try {
      let jsonText = content.text.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }
      analysisData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("Failed to parse response:", content.text);
      throw new Error("Failed to parse AI response as JSON");
    }

    return new Response(JSON.stringify(analysisData), {
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