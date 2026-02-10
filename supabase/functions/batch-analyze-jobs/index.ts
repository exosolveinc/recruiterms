import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
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
    const { session_id, resume, jobs } = await req.json();

    if (!session_id || !resume || !jobs?.length) {
      throw new Error("session_id, resume, and jobs are required");
    }

    // Create Supabase client with service role for DB writes
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const systemPrompt = `You are an expert career advisor. Analyze the match between a candidate's resume and a job posting.
Be honest but constructive. Always respond with valid JSON only.`;

    let processed = 0;

    for (const job of jobs) {
      try {
        // Mark as analyzing
        await supabase
          .from("search_results")
          .update({ status: "analyzing" })
          .eq("session_id", session_id)
          .eq("external_job_id", job.external_job_id);

        const userPrompt = `Analyze how well this candidate matches the job.

Return as JSON:
{
  "match_score": number (0-100, be realistic),
  "matching_skills": ["skill1", "skill2"],
  "missing_skills": ["skill1", "skill2"],
  "recommendations": ["recommendation1", "recommendation2"],
  "overall_assessment": "2-3 sentence summary"
}

CANDIDATE RESUME:
- Name: ${resume.candidate_name || "Unknown"}
- Current Title: ${resume.current_title || "Unknown"}
- Years of Experience: ${resume.years_of_experience || "Unknown"}
- Experience Level: ${resume.experience_level || "Unknown"}
- Professional Summary: ${resume.professional_summary || "Not provided"}
- Skills: ${JSON.stringify(resume.skills || [])}
- Education: ${JSON.stringify(resume.education || [])}
- Certifications: ${JSON.stringify(resume.certifications || [])}
- Work History: ${JSON.stringify(resume.work_history || [])}

JOB POSTING:
- Title: ${job.job_title || "Unknown"}
- Company: ${job.company_name || "Unknown"}
- Location: ${job.location || "Unknown"}
- Description: ${(job.description || "Not provided").substring(0, 3000)}

Return ONLY valid JSON, no other text.`;

        const message = await anthropic.messages.create({
          model: "claude-3-haiku-20240307",
          max_tokens: 1024,
          messages: [{ role: "user", content: userPrompt }],
          system: systemPrompt,
        });

        const content = message.content[0];
        if (content.type !== "text") {
          throw new Error("Unexpected response type");
        }

        let analysisData;
        let jsonText = content.text.trim();
        if (jsonText.startsWith("```")) {
          jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
        }
        analysisData = JSON.parse(jsonText);

        // Update row with results
        await supabase
          .from("search_results")
          .update({
            status: "completed",
            match_score: analysisData.match_score,
            matching_skills: analysisData.matching_skills || [],
            missing_skills: analysisData.missing_skills || [],
            recommendations: analysisData.recommendations || [],
            overall_assessment: analysisData.overall_assessment || "",
          })
          .eq("session_id", session_id)
          .eq("external_job_id", job.external_job_id);

        processed++;
      } catch (jobError) {
        console.error(`Error analyzing job ${job.external_job_id}:`, jobError);

        // Mark as error and continue to next job
        await supabase
          .from("search_results")
          .update({
            status: "error",
            error_message: jobError.message || "Analysis failed",
          })
          .eq("session_id", session_id)
          .eq("external_job_id", job.external_job_id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
