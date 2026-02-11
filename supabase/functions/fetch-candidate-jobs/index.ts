import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface CandidatePreferences {
  preferred_job_titles: string[];
  preferred_locations: string[];
  preferred_work_type: string[];
  salary_expectation_min: number | null;
  salary_expectation_max: number | null;
}

interface SearchQuery {
  query: string;
  location?: string;
}

interface NormalizedJob {
  candidate_id: string;
  user_id: string;
  organization_id: string | null;
  dedup_key: string;
  source_type: "api" | "email";
  source_platform: string;
  external_id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  posted_date: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string;
  pay_rate_type: string | null;
  employment_type: string;
  work_arrangement: string | null;
  duration: string | null;
  required_skills: string[];
  tech_stack: Record<string, string[]> | null;
  years_experience: string | null;
  certifications: string[];
  vendor_job_id: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  recruiter_phone: string | null;
  vendor_company: string | null;
  client_company: string | null;
  email_subject: string | null;
  email_received_at: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateDedupKey(
  title: string,
  company: string,
  location: string
): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return `${norm(title)}|${norm(company)}|${norm(location)}`;
}

function formatSalary(min?: number, max?: number): string {
  if (!min && !max) return "";
  const fmt = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`);
  if (min && max) return `${fmt(min)} - ${fmt(max)}`;
  if (min) return `From ${fmt(min)}`;
  if (max) return `Up to ${fmt(max)}`;
  return "";
}

function buildSearchQueries(prefs: CandidatePreferences | null): SearchQuery[] {
  if (!prefs) {
    return [{ query: "software engineer", location: "" }];
  }

  const queries: SearchQuery[] = [];
  const titles = prefs.preferred_job_titles?.slice(0, 3) || [];
  const locations = prefs.preferred_locations?.slice(0, 2) || [""];

  if (titles.length === 0) {
    titles.push("software engineer");
  }

  for (const title of titles) {
    for (const location of locations) {
      queries.push({ query: title, location: location || undefined });
    }
  }

  return queries.slice(0, 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── API Fetchers ────────────────────────────────────────────────────────────

async function fetchAdzunaJobs(
  query: string,
  location: string | undefined,
  appId: string,
  apiKey: string,
  maxJobs: number
): Promise<NormalizedJob[]> {
  const country = "us";
  const page = 1;
  const resultsPerPage = Math.min(maxJobs, 50);

  let url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?app_id=${appId}&app_key=${apiKey}&results_per_page=${resultsPerPage}`;
  if (query) url += `&what=${encodeURIComponent(query)}`;
  if (location) url += `&where=${encodeURIComponent(location)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Adzuna API returned ${resp.status}: ${await resp.text()}`);
      return [];
    }
    const data = await resp.json();

    return (data.results || []).map((job: any) => {
      const title = job.title || "Unknown Title";
      const company = job.company?.display_name || "Unknown Company";
      const loc = job.location?.display_name || "Unknown Location";

      return {
        candidate_id: "", // filled by caller
        user_id: "", // filled by caller
        organization_id: null,
        dedup_key: generateDedupKey(title, company, loc),
        source_type: "api" as const,
        source_platform: "adzuna",
        external_id: String(job.id || `adzuna-${Date.now()}-${Math.random()}`),
        title,
        company,
        location: loc,
        description: job.description || "",
        url: job.redirect_url || "",
        posted_date: job.created || null,
        salary_min: job.salary_min || null,
        salary_max: job.salary_max || null,
        salary_text: formatSalary(job.salary_min, job.salary_max),
        pay_rate_type: null,
        employment_type: job.contract_type || "Full-time",
        work_arrangement: null,
        duration: null,
        required_skills: [],
        tech_stack: null,
        years_experience: null,
        certifications: [],
        vendor_job_id: null,
        recruiter_name: null,
        recruiter_email: null,
        recruiter_phone: null,
        vendor_company: null,
        client_company: null,
        email_subject: null,
        email_received_at: null,
      };
    });
  } catch (err) {
    console.error("Adzuna fetch error:", err);
    return [];
  }
}

async function fetchRapidApiJobs(
  query: string,
  location: string | undefined,
  rapidApiKey: string,
  maxJobs: number
): Promise<NormalizedJob[]> {
  let searchQuery = query || "software developer";
  if (location) searchQuery += ` in ${location}`;

  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(searchQuery)}&page=1&num_pages=1`;

  try {
    const resp = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": rapidApiKey,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });
    if (!resp.ok) {
      console.error(`RapidAPI returned ${resp.status}: ${await resp.text()}`);
      return [];
    }
    const data = await resp.json();

    return (data.data || []).slice(0, maxJobs).map((job: any) => {
      const title = job.job_title || "Unknown Title";
      const company = job.employer_name || "Unknown Company";
      const loc =
        [job.job_city, job.job_state, job.job_country]
          .filter(Boolean)
          .join(", ") || "Unknown Location";

      return {
        candidate_id: "",
        user_id: "",
        organization_id: null,
        dedup_key: generateDedupKey(title, company, loc),
        source_type: "api" as const,
        source_platform: "rapidapi",
        external_id: job.job_id || `rapid-${Date.now()}-${Math.random()}`,
        title,
        company,
        location: loc,
        description: job.job_description || "",
        url: job.job_apply_link || "",
        posted_date: job.job_posted_at_datetime_utc || null,
        salary_min: job.job_min_salary || null,
        salary_max: job.job_max_salary || null,
        salary_text: formatSalary(job.job_min_salary, job.job_max_salary),
        pay_rate_type: null,
        employment_type: job.job_employment_type || "Full-time",
        work_arrangement: null,
        duration: null,
        required_skills: [],
        tech_stack: null,
        years_experience: null,
        certifications: [],
        vendor_job_id: null,
        recruiter_name: null,
        recruiter_email: null,
        recruiter_phone: null,
        vendor_company: null,
        client_company: null,
        email_subject: null,
        email_received_at: null,
      };
    });
  } catch (err) {
    console.error("RapidAPI fetch error:", err);
    return [];
  }
}

// ─── Analysis ────────────────────────────────────────────────────────────────

async function analyzeJobs(
  supabase: any,
  anthropic: any,
  candidateId: string,
  resume: any,
  maxAnalyze: number
): Promise<number> {
  // Fetch pending jobs for this candidate
  const { data: pendingJobs, error } = await supabase
    .from("job_feed")
    .select("id, title, company, location, description, required_skills, employment_type, salary_min, salary_max, work_arrangement, years_experience")
    .eq("candidate_id", candidateId)
    .eq("analysis_status", "pending")
    .limit(maxAnalyze);

  if (error || !pendingJobs?.length) return 0;

  const systemPrompt = `You are an expert career advisor. Analyze the match between a candidate's resume and a job posting.
Be honest but constructive. Always respond with valid JSON only.`;

  let analyzed = 0;

  for (const job of pendingJobs) {
    try {
      // Mark as analyzing
      await supabase
        .from("job_feed")
        .update({ analysis_status: "analyzing" })
        .eq("id", job.id);

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
- Title: ${job.title || "Unknown"}
- Company: ${job.company || "Unknown"}
- Location: ${job.location || "Unknown"}
- Description: ${(job.description || "Not provided").substring(0, 3000)}
- Required Skills: ${JSON.stringify(job.required_skills || [])}
- Employment Type: ${job.employment_type || "Unknown"}

Return ONLY valid JSON, no other text.`;

      const message = await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 1024,
        messages: [{ role: "user", content: userPrompt }],
        system: systemPrompt,
      });

      const content = message.content[0];
      if (content.type !== "text") throw new Error("Unexpected response type");

      let jsonText = content.text.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText
          .replace(/```json?\n?/g, "")
          .replace(/```$/g, "")
          .trim();
      }
      const result = JSON.parse(jsonText);

      await supabase
        .from("job_feed")
        .update({
          match_score: result.match_score,
          matching_skills: result.matching_skills || [],
          missing_skills: result.missing_skills || [],
          recommendations: result.recommendations || [],
          overall_assessment: result.overall_assessment || "",
          analysis_status: "completed",
          analyzed_at: new Date().toISOString(),
          resume_id: resume.id,
        })
        .eq("id", job.id);

      analyzed++;
    } catch (jobError: any) {
      console.error(`Error analyzing job ${job.id}:`, jobError);
      await supabase
        .from("job_feed")
        .update({
          analysis_status: "error",
          analysis_error: jobError.message || "Analysis failed",
        })
        .eq("id", job.id);
    }
  }

  return analyzed;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { candidate_id, all: fetchAll, analyze_only } = body;

    if (!candidate_id && !fetchAll) {
      throw new Error(
        "Either candidate_id or all:true is required"
      );
    }

    // Env vars
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adzunaAppId = Deno.env.get("ADZUNA_APP_ID") || "";
    const adzunaApiKey = Deno.env.get("ADZUNA_API_KEY") || "";
    const rapidApiKey = Deno.env.get("RAPID_API_KEY") || "";
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Determine which candidates to process
    let candidateRows: any[] = [];

    if (fetchAll) {
      // Fetch all candidates that have preferences set
      const { data, error } = await supabase
        .from("candidate_preferences")
        .select("candidate_id, user_id, preferred_job_titles, preferred_locations, preferred_work_type, salary_expectation_min, salary_expectation_max");

      if (error) throw error;
      candidateRows = data || [];
    } else {
      // Single candidate — read preferences
      const { data, error } = await supabase
        .from("candidate_preferences")
        .select("candidate_id, user_id, preferred_job_titles, preferred_locations, preferred_work_type, salary_expectation_min, salary_expectation_max")
        .eq("candidate_id", candidate_id)
        .single();

      if (error && error.code !== "PGRST116") throw error;

      if (data) {
        candidateRows = [data];
      } else {
        // No preferences — use a default query
        // We still need user_id. Derive from auth header or look up the candidate.
        const authHeader = req.headers.get("Authorization");
        let userId = "";
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.replace("Bearer ", "");
          // Decode JWT to get user id (service role key doesn't have sub)
          try {
            const { data: { user } } = await supabase.auth.getUser(token);
            userId = user?.id || "";
          } catch {
            // If using service role key, look up from resumes table
          }
        }

        // Try to find user_id from resumes
        if (!userId) {
          const { data: resumeData } = await supabase
            .from("resumes")
            .select("user_id")
            .eq("candidate_id", candidate_id)
            .limit(1)
            .single();
          userId = resumeData?.user_id || "";
        }

        if (!userId) {
          throw new Error("Cannot determine user_id for candidate");
        }

        candidateRows = [
          {
            candidate_id,
            user_id: userId,
            preferred_job_titles: [],
            preferred_locations: [],
            preferred_work_type: [],
            salary_expectation_min: null,
            salary_expectation_max: null,
          },
        ];
      }
    }

    const MAX_JOBS_PER_SOURCE = 30;
    let totalInserted = 0;
    let totalAnalyzed = 0;

    for (const candidate of candidateRows) {
      const cid = candidate.candidate_id;
      const uid = candidate.user_id;

      // Look up organization_id from profiles
      const { data: profileData } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", uid)
        .single();
      const orgId = profileData?.organization_id || null;

      // ─── Fetch Jobs (skip if analyze_only) ─────────────────────────
      if (!analyze_only) {
        const prefs: CandidatePreferences = {
          preferred_job_titles: candidate.preferred_job_titles || [],
          preferred_locations: candidate.preferred_locations || [],
          preferred_work_type: candidate.preferred_work_type || [],
          salary_expectation_min: candidate.salary_expectation_min,
          salary_expectation_max: candidate.salary_expectation_max,
        };

        const queries = buildSearchQueries(prefs);
        const allJobs: NormalizedJob[] = [];
        const seenKeys = new Set<string>();

        // Fetch from Adzuna
        if (adzunaAppId && adzunaApiKey) {
          for (const q of queries) {
            if (allJobs.filter((j) => j.source_platform === "adzuna").length >= MAX_JOBS_PER_SOURCE) break;
            try {
              const jobs = await fetchAdzunaJobs(
                q.query,
                q.location,
                adzunaAppId,
                adzunaApiKey,
                MAX_JOBS_PER_SOURCE
              );
              for (const job of jobs) {
                if (!seenKeys.has(job.dedup_key)) {
                  seenKeys.add(job.dedup_key);
                  job.candidate_id = cid;
                  job.user_id = uid;
                  job.organization_id = orgId;
                  allJobs.push(job);
                }
              }
            } catch (err) {
              console.error(`Adzuna error for query "${q.query}":`, err);
            }
          }
        }

        // Fetch from RapidAPI
        if (rapidApiKey) {
          for (const q of queries) {
            if (allJobs.filter((j) => j.source_platform === "rapidapi").length >= MAX_JOBS_PER_SOURCE) break;
            try {
              const jobs = await fetchRapidApiJobs(
                q.query,
                q.location,
                rapidApiKey,
                MAX_JOBS_PER_SOURCE
              );
              for (const job of jobs) {
                if (!seenKeys.has(job.dedup_key)) {
                  seenKeys.add(job.dedup_key);
                  job.candidate_id = cid;
                  job.user_id = uid;
                  job.organization_id = orgId;
                  allJobs.push(job);
                }
              }
            } catch (err) {
              console.error(`RapidAPI error for query "${q.query}":`, err);
            }
          }
        }

        // Pull vendor email jobs into job_feed
        try {
          const { data: emailJobs } = await supabase
            .from("vendor_job_email_details")
            .select("*")
            .eq("user_id", uid)
            .eq("candidate_id", cid);

          if (emailJobs?.length) {
            for (const ej of emailJobs) {
              const title = ej.job_title || "Untitled";
              const company = ej.client_company || ej.vendor_company || "Unknown Company";
              const loc = ej.location || "";
              const key = generateDedupKey(title, company, loc);

              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                allJobs.push({
                  candidate_id: cid,
                  user_id: uid,
                  organization_id: orgId,
                  dedup_key: key,
                  source_type: "email",
                  source_platform: "gmail",
                  external_id: ej.id,
                  title,
                  company,
                  location: loc,
                  description: ej.job_description || "",
                  url: "",
                  posted_date: ej.email_received_at || ej.created_at || null,
                  salary_min: ej.pay_rate_min || null,
                  salary_max: ej.pay_rate_max || null,
                  salary_text: ej.pay_rate || "",
                  pay_rate_type: null,
                  employment_type: ej.employment_type || "",
                  work_arrangement: ej.work_arrangement || null,
                  duration: ej.duration || null,
                  required_skills: ej.required_skills || [],
                  tech_stack: ej.tech_stack || null,
                  years_experience: ej.years_experience || null,
                  certifications: [],
                  vendor_job_id: ej.id,
                  recruiter_name: ej.recruiter_name || null,
                  recruiter_email: ej.recruiter_email || null,
                  recruiter_phone: ej.recruiter_phone || null,
                  vendor_company: ej.vendor_company || null,
                  client_company: ej.client_company || null,
                  email_subject: ej.email_subject || null,
                  email_received_at: ej.email_received_at || null,
                });
              }
            }
          }
        } catch (err) {
          console.error("Error fetching email jobs:", err);
        }

        // Upsert jobs into job_feed
        if (allJobs.length > 0) {
          // Batch upsert in chunks of 50
          for (let i = 0; i < allJobs.length; i += 50) {
            const batch = allJobs.slice(i, i + 50);
            const { error: upsertError, count } = await supabase
              .from("job_feed")
              .upsert(
                batch.map((j) => ({
                  candidate_id: j.candidate_id,
                  user_id: j.user_id,
                  organization_id: j.organization_id,
                  dedup_key: j.dedup_key,
                  source_type: j.source_type,
                  source_platform: j.source_platform,
                  external_id: j.external_id,
                  title: j.title,
                  company: j.company,
                  location: j.location,
                  description: j.description,
                  url: j.url,
                  posted_date: j.posted_date,
                  salary_min: j.salary_min,
                  salary_max: j.salary_max,
                  salary_text: j.salary_text,
                  pay_rate_type: j.pay_rate_type,
                  employment_type: j.employment_type,
                  work_arrangement: j.work_arrangement,
                  duration: j.duration,
                  required_skills: j.required_skills,
                  tech_stack: j.tech_stack,
                  years_experience: j.years_experience,
                  certifications: j.certifications,
                  vendor_job_id: j.vendor_job_id,
                  recruiter_name: j.recruiter_name,
                  recruiter_email: j.recruiter_email,
                  recruiter_phone: j.recruiter_phone,
                  vendor_company: j.vendor_company,
                  client_company: j.client_company,
                  email_subject: j.email_subject,
                  email_received_at: j.email_received_at,
                })),
                {
                  onConflict: "candidate_id,dedup_key",
                  ignoreDuplicates: false,
                }
              );

            if (upsertError) {
              console.error("Upsert error:", upsertError);
            } else {
              totalInserted += batch.length;
            }
          }
        }
      }

      // ─── Analyze pending jobs ──────────────────────────────────────
      if (anthropicApiKey) {
        // Get the candidate's primary resume
        const { data: resumes } = await supabase
          .from("resumes")
          .select("*")
          .eq("candidate_id", cid)
          .order("is_primary", { ascending: false })
          .limit(1);

        if (resumes?.length) {
          const anthropic = new Anthropic({ apiKey: anthropicApiKey });
          const analyzed = await analyzeJobs(
            supabase,
            anthropic,
            cid,
            resumes[0],
            10
          );
          totalAnalyzed += analyzed;
        }
      }

      // Delay between candidates in batch mode
      if (fetchAll && candidateRows.length > 1) {
        await delay(500);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        candidates_processed: candidateRows.length,
        jobs_upserted: totalInserted,
        jobs_analyzed: totalAnalyzed,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
