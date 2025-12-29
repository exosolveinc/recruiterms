import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @deno-types="npm:openai@4.20.1"
import OpenAI from "npm:openai@4.20.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Platform detection from URL
function detectPlatformFromUrl(url: string): string {
  if (!url) return "Unknown";
  const urlLower = url.toLowerCase();

  if (urlLower.includes("linkedin.com")) return "LinkedIn";
  if (urlLower.includes("indeed.com")) return "Indeed";
  if (urlLower.includes("glassdoor.com")) return "Glassdoor";
  if (urlLower.includes("dice.com")) return "Dice";
  if (urlLower.includes("ziprecruiter.com")) return "ZipRecruiter";
  if (urlLower.includes("monster.com")) return "Monster";
  if (urlLower.includes("careerbuilder.com")) return "CareerBuilder";
  if (urlLower.includes("simplyhired.com")) return "SimplyHired";
  if (urlLower.includes("angel.co") || urlLower.includes("wellfound.com")) return "AngelList";
  if (urlLower.includes("greenhouse.io")) return "Greenhouse";
  if (urlLower.includes("lever.co")) return "Lever";
  if (urlLower.includes("workday.com")) return "Workday";
  if (urlLower.includes("icims.com")) return "iCIMS";
  if (urlLower.includes("smartrecruiters.com")) return "SmartRecruiters";
  if (urlLower.includes("jobvite.com")) return "Jobvite";
  if (urlLower.includes("ashbyhq.com")) return "Ashby";
  if (urlLower.includes("breezy.hr")) return "Breezy";
  if (urlLower.includes("bamboohr.com")) return "BambooHR";
  if (urlLower.includes("recruitee.com")) return "Recruitee";
  if (urlLower.includes("applytojob.com")) return "JazzHR";
  if (urlLower.includes("myworkdayjobs.com")) return "Workday";
  if (urlLower.includes("jobs.") || urlLower.includes("/jobs") || urlLower.includes("/careers")) return "Company Website";

  return "Other";
}

// Fetch job page content from URL
async function fetchJobContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      console.warn(`Failed to fetch URL (${response.status}): ${url}`);
      return "";
    }

    const html = await response.text();

    // Extract text content from HTML
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&bull;/g, "•")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > 15000) {
      text = text.substring(0, 15000) + "...";
    }

    return text;
  } catch (error) {
    console.error("Error fetching URL:", error);
    return "";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { jobDescription, jobUrl, platform } = await req.json();

    if (!jobDescription && !jobUrl) {
      throw new Error("Job description or URL is required");
    }

    // Auto-detect platform from URL
    const detectedPlatform = jobUrl ? detectPlatformFromUrl(jobUrl) : "Unknown";
    const finalPlatform = (platform && platform !== "Auto-detect" && platform !== "Unknown")
      ? platform
      : detectedPlatform;

    // Try to fetch content from URL if no description provided
    let contentToAnalyze = jobDescription || "";
    if (jobUrl && !jobDescription) {
      console.log("Fetching job content from URL:", jobUrl);
      contentToAnalyze = await fetchJobContent(jobUrl);
      console.log("Fetched content length:", contentToAnalyze.length);
    }

    if (!contentToAnalyze || contentToAnalyze.length < 50) {
      throw new Error("Could not fetch job content from URL. Please paste the job description manually.");
    }

    const openai = new OpenAI({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    });

    const systemPrompt = `You are an expert job posting analyzer. Extract structured information from job descriptions accurately and return ONLY valid JSON. Do not include any text before or after the JSON object.`;

    const userPrompt = `Extract the following information from this job posting. Return a JSON object with these fields:

- platform: "${finalPlatform}"
- job_title: string (exact job title)
- company_name: string
- company_website: string or null
- company_size: "Startup" | "Small" | "Medium" | "Large" | "Enterprise" or null
- company_industry: string or null
- location: string (full location)
- city: string or null
- state: string or null
- country: string or null
- is_remote: boolean
- work_type: "Remote" | "Hybrid" | "Onsite" | "Flexible"
- employment_type: "Full-time" | "Part-time" | "Contract" | "Freelance" | "Internship"
- experience_level: "Entry" | "Junior" | "Mid" | "Senior" | "Lead" | "Executive"
- years_experience_required: string like "3+ years" or "2-4 years" or null
- salary_raw: string (original salary text) or null
- salary_min: number or null
- salary_max: number or null
- salary_currency: "USD" | "EUR" | "GBP" etc or null
- salary_period: "Yearly" | "Monthly" | "Hourly" or null
- has_bonus: boolean or null
- has_equity: boolean or null
- required_skills: array of { skill: string, importance: "Required" | "Preferred" }
- required_education: string or null
- required_certifications: array of strings or null
- benefits: array of { category: "Health" | "Financial" | "PTO" | "Perks" | "Other", items: string[] }
- description_summary: string (2-3 sentence summary)
- responsibilities: array of strings
- qualifications: array of strings
- visa_sponsorship: boolean or null
- easy_apply: boolean or null

Job URL: ${jobUrl || 'Not provided'}

Job Content:
${contentToAnalyze}

Return ONLY the JSON object, no other text.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from AI");
    }

    let extractedData;
    try {
      extractedData = JSON.parse(content);
    } catch (parseError) {
      console.error("Failed to parse response:", content);
      throw new Error("Failed to parse AI response as JSON");
    }

    // Validate we got meaningful data
    if (!extractedData.job_title || extractedData.job_title === "null") {
      throw new Error("Could not extract job details. Please paste the job description text instead.");
    }

    // Add confidence score
    const fields = ["job_title", "company_name", "location", "required_skills", "employment_type"];
    const filledFields = fields.filter(f => {
      const val = extractedData[f];
      return val && val !== "null" && (Array.isArray(val) ? val.length > 0 : true);
    });
    extractedData.extraction_confidence = Number((filledFields.length / fields.length).toFixed(2));

    // Ensure platform is set
    extractedData.platform = extractedData.platform || finalPlatform;

    return new Response(JSON.stringify(extractedData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
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
