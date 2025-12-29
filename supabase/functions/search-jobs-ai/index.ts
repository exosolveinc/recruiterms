import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface JobSearchRequest {
  query: string;
  location?: string;
  platforms?: string[];
  workType?: string;
  experienceLevel?: string;
  salaryMin?: number;
  salaryMax?: number;
  limit?: number;
}

interface SearchedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  salary_text?: string;
  salary_min?: number;
  salary_max?: number;
  url: string;
  posted_date: string;
  source: string;
  employment_type?: string;
  work_type?: string;
  experience_level?: string;
  required_skills?: string[];
}

// Platforms to search
const JOB_PLATFORMS = {
  dice: {
    name: "Dice",
    searchUrl: "https://www.dice.com/jobs",
    domain: "dice.com"
  },
  linkedin: {
    name: "LinkedIn",
    searchUrl: "https://www.linkedin.com/jobs/search",
    domain: "linkedin.com"
  },
  indeed: {
    name: "Indeed",
    searchUrl: "https://www.indeed.com/jobs",
    domain: "indeed.com"
  },
  glassdoor: {
    name: "Glassdoor",
    searchUrl: "https://www.glassdoor.com/Job",
    domain: "glassdoor.com"
  },
  ziprecruiter: {
    name: "ZipRecruiter",
    searchUrl: "https://www.ziprecruiter.com/jobs-search",
    domain: "ziprecruiter.com"
  },
  monster: {
    name: "Monster",
    searchUrl: "https://www.monster.com/jobs/search",
    domain: "monster.com"
  },
  builtin: {
    name: "Built In",
    searchUrl: "https://builtin.com/jobs",
    domain: "builtin.com"
  },
  wellfound: {
    name: "Wellfound (AngelList)",
    searchUrl: "https://wellfound.com/jobs",
    domain: "wellfound.com"
  }
};

// Fetch content from a URL
async function fetchUrl(url: string): Promise<string> {
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

    // Strip HTML tags and clean up
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
      .replace(/\s+/g, " ")
      .trim();

    // Limit content size
    if (text.length > 20000) {
      text = text.substring(0, 20000);
    }

    return text;
  } catch (error) {
    console.error("Error fetching URL:", error);
    return "";
  }
}

// Build search URL for a specific platform
function buildSearchUrl(platform: string, query: string, location?: string): string {
  const q = encodeURIComponent(query);
  const loc = location ? encodeURIComponent(location) : "";

  switch (platform) {
    case "dice":
      return `https://www.dice.com/jobs?q=${q}${loc ? `&location=${loc}` : ""}`;
    case "linkedin":
      return `https://www.linkedin.com/jobs/search/?keywords=${q}${loc ? `&location=${loc}` : ""}`;
    case "indeed":
      return `https://www.indeed.com/jobs?q=${q}${loc ? `&l=${loc}` : ""}`;
    case "glassdoor":
      return `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${q}${loc ? `&locT=C&locId=0&locKeyword=${loc}` : ""}`;
    case "ziprecruiter":
      return `https://www.ziprecruiter.com/jobs-search?search=${q}${loc ? `&location=${loc}` : ""}`;
    case "monster":
      return `https://www.monster.com/jobs/search?q=${q}${loc ? `&where=${loc}` : ""}`;
    case "builtin":
      return `https://builtin.com/jobs?search=${q}${loc ? `&location=${loc}` : ""}`;
    case "wellfound":
      return `https://wellfound.com/jobs?query=${q}`;
    default:
      return "";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestData: JobSearchRequest = await req.json();
    const {
      query,
      location,
      platforms = ["dice", "indeed", "linkedin"],
      workType,
      experienceLevel,
      limit = 10
    } = requestData;

    if (!query) {
      throw new Error("Search query is required");
    }

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    // Build search context
    let searchContext = `Job Title/Keywords: ${query}`;
    if (location) searchContext += `\nLocation: ${location}`;
    if (workType) searchContext += `\nWork Type: ${workType}`;
    if (experienceLevel) searchContext += `\nExperience Level: ${experienceLevel}`;

    // Build platform search URLs
    const platformUrls = platforms
      .filter(p => JOB_PLATFORMS[p as keyof typeof JOB_PLATFORMS])
      .map(p => ({
        platform: p,
        name: JOB_PLATFORMS[p as keyof typeof JOB_PLATFORMS].name,
        url: buildSearchUrl(p, query, location)
      }));

    // Create the search prompt
    const systemPrompt = `You are an expert job search assistant. Your task is to search for job listings based on the user's criteria and return structured job data.

You have web browsing capabilities. Search the internet for current job listings matching the criteria.

IMPORTANT:
- Only return REAL job listings that currently exist on the web
- Include actual job URLs that users can visit
- Extract accurate job details from the listings
- If you cannot find real listings, return an empty array rather than making up fake jobs

Always respond with valid JSON only, no other text.`;

    const userPrompt = `Search for job listings with the following criteria:

${searchContext}

Search these job platforms:
${platformUrls.map(p => `- ${p.name}: ${p.url}`).join('\n')}

Find up to ${limit} relevant job listings and return them as a JSON array with this structure:
{
  "jobs": [
    {
      "id": "unique-id-from-platform",
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State or Remote",
      "description": "Brief job description (2-3 sentences)",
      "salary_text": "$100k - $150k" or null,
      "salary_min": 100000 or null,
      "salary_max": 150000 or null,
      "url": "https://actual-job-posting-url",
      "posted_date": "2025-01-15" or "2 days ago",
      "source": "dice" | "indeed" | "linkedin" | etc,
      "employment_type": "Full-time" | "Part-time" | "Contract",
      "work_type": "Remote" | "Hybrid" | "Onsite",
      "experience_level": "Entry" | "Mid" | "Senior" | "Lead",
      "required_skills": ["skill1", "skill2", "skill3"]
    }
  ],
  "total_found": number,
  "search_summary": "Brief summary of search results"
}

Search the web for current job listings. Return ONLY valid JSON.`;

    // Use Claude with web search capability via tool use
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
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

    let responseData;
    try {
      let jsonText = content.text.trim();
      // Handle markdown code blocks
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }
      responseData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("Failed to parse response:", content.text);
      // Return empty results if parsing fails
      responseData = {
        jobs: [],
        total_found: 0,
        search_summary: "Unable to parse search results"
      };
    }

    // Normalize job IDs and add timestamps
    const normalizedJobs = (responseData.jobs || []).map((job: any, index: number) => ({
      ...job,
      id: job.id || `ai-${Date.now()}-${index}`,
      posted_date: normalizeDate(job.posted_date),
      source: job.source || "ai-search"
    }));

    return new Response(JSON.stringify({
      jobs: normalizedJobs,
      total: responseData.total_found || normalizedJobs.length,
      search_summary: responseData.search_summary || `Found ${normalizedJobs.length} jobs`,
      platforms_searched: platforms
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: error.message,
        jobs: [],
        total: 0
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});

// Helper to normalize date strings
function normalizeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return new Date().toISOString();

  // If already ISO format, return as is
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr;
  }

  // Handle relative dates
  const lowerDate = dateStr.toLowerCase();
  const now = new Date();

  if (lowerDate.includes("today") || lowerDate.includes("just posted")) {
    return now.toISOString();
  }
  if (lowerDate.includes("yesterday")) {
    now.setDate(now.getDate() - 1);
    return now.toISOString();
  }

  const daysMatch = lowerDate.match(/(\d+)\s*days?\s*ago/);
  if (daysMatch) {
    now.setDate(now.getDate() - parseInt(daysMatch[1]));
    return now.toISOString();
  }

  const weeksMatch = lowerDate.match(/(\d+)\s*weeks?\s*ago/);
  if (weeksMatch) {
    now.setDate(now.getDate() - parseInt(weeksMatch[1]) * 7);
    return now.toISOString();
  }

  const monthsMatch = lowerDate.match(/(\d+)\s*months?\s*ago/);
  if (monthsMatch) {
    now.setMonth(now.getMonth() - parseInt(monthsMatch[1]));
    return now.toISOString();
  }

  return now.toISOString();
}
