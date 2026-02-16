import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get all active users (those with at least one application)
    const { data: users, error: usersError } = await supabase
      .from("job_applications")
      .select("user_id")
      .order("applied_at", { ascending: false });

    if (usersError) throw usersError;

    // Deduplicate user IDs
    const uniqueUserIds = [...new Set((users || []).map((u: any) => u.user_id))];

    if (uniqueUserIds.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No users with applications" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const today = new Date().toISOString().split("T")[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let generated = 0;
    let skipped = 0;

    for (const userId of uniqueUserIds) {
      try {
        // Skip if insight already exists for today
        const { data: existing } = await supabase
          .from("application_board_insights")
          .select("id")
          .eq("user_id", userId)
          .eq("insight_date", today)
          .maybeSingle();

        if (existing) {
          skipped++;
          continue;
        }

        // ── Gather pipeline data from DB ──

        // 1. All applications for this user (via the view or direct table)
        const { data: apps } = await supabase
          .from("job_applications")
          .select("status, applied_at, job_id")
          .eq("user_id", userId);

        const allApps = apps || [];
        if (allApps.length === 0) continue;

        // Status counts
        const statusCounts: Record<string, number> = {};
        for (const app of allApps) {
          statusCounts[app.status] = (statusCounts[app.status] || 0) + 1;
        }

        // Recent activity (last 7 days)
        const recentActivity = allApps.filter(
          (a: any) => new Date(a.applied_at) >= new Date(sevenDaysAgo)
        ).length;

        // 2. Job details for companies, skills, match scores
        const jobIds = [...new Set(allApps.map((a: any) => a.job_id).filter(Boolean))];

        let topCompanies: string[] = [];
        let topMatchingSkills: string[] = [];
        let topMissingSkills: string[] = [];
        let avgMatchScore = 0;
        let matchCount = 0;

        if (jobIds.length > 0) {
          const { data: jobs } = await supabase
            .from("jobs")
            .select("company_name, match_score, required_skills")
            .in("id", jobIds);

          const jobList = jobs || [];

          // Top companies by frequency
          const companyCounts = new Map<string, number>();
          for (const j of jobList) {
            if (j.company_name) {
              companyCounts.set(j.company_name, (companyCounts.get(j.company_name) || 0) + 1);
            }
          }
          topCompanies = [...companyCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name]) => name);

          // Average match score
          for (const j of jobList) {
            if (j.match_score) {
              avgMatchScore += j.match_score;
              matchCount++;
            }
          }
          if (matchCount > 0) avgMatchScore = Math.round(avgMatchScore / matchCount);

          // Aggregate required skills
          const skillCounts = new Map<string, number>();
          for (const j of jobList) {
            if (j.required_skills && Array.isArray(j.required_skills)) {
              for (const skill of j.required_skills) {
                skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
              }
            }
          }
          const sortedSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]);
          topMatchingSkills = sortedSkills.slice(0, 5).map(([s]) => s);
        }

        // 3. Get matching/missing skills from search_results if available
        const { data: searchResults } = await supabase
          .from("search_results")
          .select("matching_skills, missing_skills")
          .eq("user_id", userId)
          .not("matching_skills", "is", null);

        if (searchResults && searchResults.length > 0) {
          const missingCounts = new Map<string, number>();
          const matchingCounts = new Map<string, number>();

          for (const sr of searchResults) {
            if (sr.missing_skills && Array.isArray(sr.missing_skills)) {
              for (const s of sr.missing_skills) {
                missingCounts.set(s, (missingCounts.get(s) || 0) + 1);
              }
            }
            if (sr.matching_skills && Array.isArray(sr.matching_skills)) {
              for (const s of sr.matching_skills) {
                matchingCounts.set(s, (matchingCounts.get(s) || 0) + 1);
              }
            }
          }

          if (missingCounts.size > 0) {
            topMissingSkills = [...missingCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([s]) => s);
          }

          if (matchingCounts.size > 0) {
            topMatchingSkills = [...matchingCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([s]) => s);
          }
        }

        // ── Build analytical prompt ──

        const total = allApps.length;
        const applied = statusCounts["applied"] || 0;
        const screening = statusCounts["screening"] || 0;
        const interviewing = statusCounts["interviewing"] || 0;
        const offer = statusCounts["offer"] || 0;
        const accepted = statusCounts["accepted"] || 0;
        const rejected = statusCounts["rejected"] || 0;
        const withdrawn = statusCounts["withdrawn"] || 0;

        const conversionRate = total > 0 ? Math.round(((interviewing + offer + accepted) / total) * 100) : 0;
        const rejectionRate = total > 0 ? Math.round((rejected / total) * 100) : 0;

        const systemPrompt = `You are a recruitment analytics advisor. Write exactly 2-3 SHORT sentences (under 40 words total). Pick the single most critical insight from the data — a bottleneck, a skill gap, or a win — reference one or two numbers, then suggest one specific action. No markdown, no bullets, no fluff. Be direct.`;

        const userPrompt = `PIPELINE BREAKDOWN:
Total: ${total} | Applied: ${applied} | Screening: ${screening} | Interviewing: ${interviewing} | Offers: ${offer} | Accepted: ${accepted} | Rejected: ${rejected} | Withdrawn: ${withdrawn}
Conversion rate (to interview+): ${conversionRate}% | Rejection rate: ${rejectionRate}%

ACTIVITY: ${recentActivity} new applications in last 7 days

TOP COMPANIES: ${topCompanies.length > 0 ? topCompanies.join(", ") : "None yet"}
STRONGEST SKILLS: ${topMatchingSkills.length > 0 ? topMatchingSkills.join(", ") : "Not analyzed"}
SKILL GAPS (frequently missing): ${topMissingSkills.length > 0 ? topMissingSkills.join(", ") : "None identified"}
AVERAGE MATCH SCORE: ${avgMatchScore > 0 ? avgMatchScore + "%" : "Not available"}`;

        // ── Call Claude 3 Haiku ──

        const response = await anthropic.messages.create({
          model: "claude-3-haiku-20240307",
          max_tokens: 120,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });

        const content = response.content[0];
        if (content.type !== "text") continue;

        // ── Upsert insight ──

        await supabase
          .from("application_board_insights")
          .upsert(
            {
              user_id: userId,
              content: content.text,
              insight_date: today,
              generated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,insight_date" }
          );

        generated++;
      } catch (userError: any) {
        console.error(`Error generating insight for user ${userId}:`, userError.message);
      }
    }

    // ── Phase 2: Job Feed Insights (per candidate) ──

    let feedGenerated = 0;

    // Get all unique user+candidate combos from job_feed
    const { data: feedEntries } = await supabase
      .from("job_feed")
      .select("user_id, candidate_id")
      .not("candidate_id", "is", null);

    const candidatePairs = new Map<string, { userId: string; candidateId: string }>();
    for (const entry of feedEntries || []) {
      const key = `${entry.user_id}|${entry.candidate_id}`;
      if (!candidatePairs.has(key)) {
        candidatePairs.set(key, { userId: entry.user_id, candidateId: entry.candidate_id });
      }
    }

    for (const { userId, candidateId } of candidatePairs.values()) {
      try {
        // Skip if exists for today
        const { data: existingFeed } = await supabase
          .from("job_feed_insights")
          .select("id")
          .eq("user_id", userId)
          .eq("candidate_id", candidateId)
          .eq("insight_date", today)
          .maybeSingle();

        if (existingFeed) continue;

        // Get job feed stats for this candidate
        const { data: feedJobs } = await supabase
          .from("job_feed")
          .select("match_score, matching_skills, missing_skills, company, title, source_platform, status, discovered_at")
          .eq("user_id", userId)
          .eq("candidate_id", candidateId);

        const allFeedJobs = feedJobs || [];
        if (allFeedJobs.length === 0) continue;

        const totalJobs = allFeedJobs.length;
        const analyzedJobs = allFeedJobs.filter((j: any) => j.match_score !== null);
        const avgFeedMatch = analyzedJobs.length > 0
          ? Math.round(analyzedJobs.reduce((sum: number, j: any) => sum + (j.match_score || 0), 0) / analyzedJobs.length)
          : 0;
        const highMatchJobs = analyzedJobs.filter((j: any) => j.match_score >= 80).length;
        const newJobs = allFeedJobs.filter((j: any) => j.status === "new").length;

        // Top companies
        const feedCompanyCounts = new Map<string, number>();
        for (const j of allFeedJobs) {
          if (j.company) feedCompanyCounts.set(j.company, (feedCompanyCounts.get(j.company) || 0) + 1);
        }
        const feedTopCompanies = [...feedCompanyCounts.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);

        // Skill gaps from feed
        const feedMissingCounts = new Map<string, number>();
        const feedMatchingCounts = new Map<string, number>();
        for (const j of allFeedJobs) {
          if (j.missing_skills && Array.isArray(j.missing_skills)) {
            for (const s of j.missing_skills) feedMissingCounts.set(s, (feedMissingCounts.get(s) || 0) + 1);
          }
          if (j.matching_skills && Array.isArray(j.matching_skills)) {
            for (const s of j.matching_skills) feedMatchingCounts.set(s, (feedMatchingCounts.get(s) || 0) + 1);
          }
        }
        const feedTopMissing = [...feedMissingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
        const feedTopMatching = [...feedMatchingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);

        // Sources
        const sourceCounts = new Map<string, number>();
        for (const j of allFeedJobs) {
          if (j.source_platform) sourceCounts.set(j.source_platform, (sourceCounts.get(j.source_platform) || 0) + 1);
        }
        const topSources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, c]) => `${s}(${c})`);

        const feedSystemPrompt = `You are a job market advisor. Write exactly 2-3 SHORT sentences (under 40 words total). Analyze this candidate's job feed — highlight the most critical pattern (skill gap, strong matches, or market trend), reference one or two numbers, then suggest one specific action. No markdown, no bullets. Be direct.`;

        const feedUserPrompt = `JOB FEED SUMMARY:
Total jobs: ${totalJobs} | New unseen: ${newJobs} | High match (80%+): ${highMatchJobs}
Average match score: ${avgFeedMatch > 0 ? avgFeedMatch + "%" : "N/A"}
Sources: ${topSources.length > 0 ? topSources.join(", ") : "N/A"}
Top companies hiring: ${feedTopCompanies.length > 0 ? feedTopCompanies.join(", ") : "N/A"}
Strongest skills: ${feedTopMatching.length > 0 ? feedTopMatching.join(", ") : "N/A"}
Skill gaps (frequently missing): ${feedTopMissing.length > 0 ? feedTopMissing.join(", ") : "N/A"}`;

        const feedResponse = await anthropic.messages.create({
          model: "claude-3-haiku-20240307",
          max_tokens: 120,
          system: feedSystemPrompt,
          messages: [{ role: "user", content: feedUserPrompt }],
        });

        const feedContent = feedResponse.content[0];
        if (feedContent.type !== "text") continue;

        await supabase
          .from("job_feed_insights")
          .upsert(
            {
              user_id: userId,
              candidate_id: candidateId,
              content: feedContent.text,
              insight_date: today,
              generated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,candidate_id,insight_date" }
          );

        feedGenerated++;
      } catch (feedError: any) {
        console.error(`Error generating feed insight for candidate ${candidateId}:`, feedError.message);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        board_generated: generated,
        board_skipped: skipped,
        feed_generated: feedGenerated,
        total_users: uniqueUserIds.length,
        total_candidates: candidatePairs.size,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error in generate-board-insight:", error);

    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
