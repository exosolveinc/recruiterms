import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface InsightRequest {
  interviewId: string;
  applicationId: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeSummary: string;
  workHistory: Array<{
    title: string;
    company: string;
    start: string;
    end?: string;
    description?: string;
    achievements?: string[];
  }>;
  skills: Array<{
    name: string;
    proficiency?: string;
    years?: number;
  }>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const request: InsightRequest = await req.json();
    const {
      interviewId,
      applicationId,
      jobTitle,
      companyName,
      jobDescription,
      resumeSummary,
      workHistory,
      skills
    } = request;

    if (!interviewId || !applicationId) {
      throw new Error("Missing required fields: interviewId, applicationId");
    }

    // Format work history for prompt
    const formattedWorkHistory = workHistory.map((job, idx) => {
      let entry = `${idx + 1}. ${job.title} at ${job.company}`;
      entry += `\n   Period: ${job.start} - ${job.end || 'Present'}`;
      if (job.description) {
        entry += `\n   Description: ${job.description}`;
      }
      if (job.achievements && job.achievements.length > 0) {
        entry += `\n   Key Achievements: ${job.achievements.join('; ')}`;
      }
      return entry;
    }).join('\n\n');

    // Format skills
    const formattedSkills = skills.map(s => {
      let skill = s.name;
      if (s.proficiency) skill += ` (${s.proficiency})`;
      if (s.years) skill += ` - ${s.years} years`;
      return skill;
    }).join(', ');

    // Build the prompt
    const systemPrompt = `You are an expert interview preparation coach. Generate personalized interview insights and talking points based on the candidate's background and the job they're interviewing for.

Your response should be practical, specific, and help the candidate prepare for common interview questions.

IMPORTANT: Generate insights even if there's minimal match between the resume and job description. Focus on transferable skills and relevant experiences.`;

    const userPrompt = `Generate interview preparation insights for:

**TARGET POSITION:**
- Job Title: ${jobTitle}
- Company: ${companyName}
- Job Description: ${jobDescription || 'Not provided'}

**CANDIDATE BACKGROUND:**
- Professional Summary: ${resumeSummary || 'Not provided'}

- Work History:
${formattedWorkHistory || 'Not provided'}

- Skills: ${formattedSkills || 'Not provided'}

Please provide:

## 1. What I Did at My Previous Company
Generate 3-4 concise bullet points highlighting the most relevant accomplishments from my work history that align with this role. Frame them using the STAR method (Situation, Task, Action, Result) format.

## 2. Why I'm Leaving / Looking for New Opportunities
Suggest 2-3 professional, positive reasons for seeking this new opportunity. Focus on:
- Career growth and new challenges
- Alignment with career goals
- Interest in the company's mission/technology
Avoid negative reasons about current/previous employer.

## 3. Key Talking Points
List 4-5 specific talking points that connect my experience to this role's requirements.

## 4. Questions to Prepare For
List 3-4 likely interview questions for this role with brief suggested response angles.

## 5. Questions to Ask the Interviewer
Suggest 3-4 thoughtful questions to ask that show genuine interest and research.

Keep the response concise but comprehensive. Use bullet points for readability.`;

    // Call Claude
    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    const insightContent = content.text;

    // Save to database
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (supabaseUrl && supabaseServiceKey) {
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      // Upsert the insight
      await supabase
        .from("interview_ai_insights")
        .upsert({
          interview_id: interviewId,
          application_id: applicationId,
          content: insightContent,
          generated_at: new Date().toISOString()
        }, {
          onConflict: 'interview_id'
        });
    }

    return new Response(JSON.stringify({
      success: true,
      content: insightContent
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error generating interview insight:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
