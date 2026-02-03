import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { JWT } from "npm:google-auth-library@9.0.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ScheduleRequest {
  userMessage: string;
  duration: number;
  dateRange: {
    start: string;
    end: string;
  };
  timezone: string;
  userId?: string;
  resumeIds?: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}

interface DatabaseInterview {
  id: string;
  title: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  application_id: string;
}

interface ApplicationData {
  id: string;
  job_title: string;
  company_name: string;
  status: string;
  match_score: number | null;
  applied_at: string | null;
  resume_id: string | null;
  candidate_name?: string;
}

interface SuggestedSlot {
  date: string;
  startTime: string;
  endTime: string;
  datetime: string;
  reason: string;
  applicationId?: string;
  companyName?: string;
  jobTitle?: string;
}

interface AvailableSlot {
  date: string;
  dayName: string;
  start: string;
  end: string;
  durationMinutes: number;
}

async function fetchUserApplications(userId: string, resumeIds?: string[]): Promise<ApplicationData[]> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Supabase credentials not configured");
    return [];
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Fetch applications with job details
  let query = supabase
    .from("user_applications")
    .select("id, job_title, company_name, status, match_score, applied_at, resume_id")
    .eq("user_id", userId)
    .in("status", ["applied", "screening", "interviewing"])
    .order("applied_at", { ascending: false });

  // Filter by candidate's resumes if resumeIds provided
  if (resumeIds && resumeIds.length > 0) {
    query = query.in("resume_id", resumeIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Failed to fetch applications:", error);
    return [];
  }

  return data || [];
}

async function fetchDatabaseInterviews(
  timeMin: string,
  timeMax: string,
  userId?: string
): Promise<DatabaseInterview[]> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Supabase credentials not configured");
    return [];
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let query = supabase
    .from("scheduled_interviews")
    .select("id, title, scheduled_at, duration_minutes, status, application_id")
    .gte("scheduled_at", timeMin)
    .lte("scheduled_at", timeMax)
    .in("status", ["pending", "scheduled"]);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Failed to fetch database interviews:", error);
    return [];
  }

  return data || [];
}

function convertInterviewsToEvents(interviews: DatabaseInterview[]): CalendarEvent[] {
  return interviews.map(interview => {
    const start = new Date(interview.scheduled_at);
    const end = new Date(start.getTime() + interview.duration_minutes * 60 * 1000);

    return {
      id: interview.id,
      summary: `[Scheduled] ${interview.title}`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    };
  });
}

async function getGoogleAccessToken(): Promise<string> {
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  }

  const credentials = JSON.parse(serviceAccountJson);
  const jwtClient = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const tokens = await jwtClient.authorize();
  if (!tokens.access_token) {
    throw new Error("Failed to get Google access token");
  }

  return tokens.access_token;
}

async function fetchCalendarEvents(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarEvent[]> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '100');

  const response = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Calendar API error:', errorText);
    throw new Error(`Failed to fetch calendar events: ${response.status}`);
  }

  const data = await response.json();
  return data.items || [];
}

function parseEventTime(event: CalendarEvent): { start: Date; end: Date } | null {
  const startStr = event.start.dateTime || event.start.date;
  const endStr = event.end.dateTime || event.end.date;

  if (!startStr || !endStr) return null;

  return {
    start: new Date(startStr),
    end: new Date(endStr)
  };
}

function findAvailableSlots(
  events: CalendarEvent[],
  dateRange: { start: string; end: string },
  durationMinutes: number,
  timezone: string
): AvailableSlot[] {
  const availableSlots: AvailableSlot[] = [];
  const startDate = new Date(dateRange.start);
  const endDate = new Date(dateRange.end);

  // Working hours: 9:00 AM to 6:00 PM
  const workStartHour = 9;
  const workEndHour = 18;

  // Parse all events into time ranges
  const busyTimes: Array<{ start: Date; end: Date }> = [];
  for (const event of events) {
    const times = parseEventTime(event);
    if (times) {
      busyTimes.push(times);
    }
  }

  // Sort busy times by start
  busyTimes.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Iterate through each day in the range
  const currentDate = new Date(startDate);
  currentDate.setHours(0, 0, 0, 0);

  while (currentDate <= endDate) {
    const dayOfWeek = currentDate.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const dayStart = new Date(currentDate);
    dayStart.setHours(workStartHour, 0, 0, 0);

    const dayEnd = new Date(currentDate);
    dayEnd.setHours(workEndHour, 0, 0, 0);

    // Get busy times for this day
    const dayBusyTimes = busyTimes.filter(bt => {
      return bt.start < dayEnd && bt.end > dayStart;
    });

    // Find free slots in the day
    let slotStart = dayStart;

    for (const busy of dayBusyTimes) {
      if (busy.start > slotStart) {
        const gapMinutes = (busy.start.getTime() - slotStart.getTime()) / (1000 * 60);

        if (gapMinutes >= durationMinutes + 15) {
          const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);

          if (slotEnd <= dayEnd) {
            availableSlots.push({
              date: currentDate.toISOString().split('T')[0],
              dayName: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
              start: slotStart.toTimeString().slice(0, 5),
              end: slotEnd.toTimeString().slice(0, 5),
              durationMinutes: gapMinutes
            });
          }
        }
      }

      const busyEndWithBuffer = new Date(busy.end.getTime() + 15 * 60 * 1000);
      if (busyEndWithBuffer > slotStart) {
        slotStart = busyEndWithBuffer;
      }
    }

    // Check for slot at end of day
    if (slotStart < dayEnd) {
      const remainingMinutes = (dayEnd.getTime() - slotStart.getTime()) / (1000 * 60);

      if (remainingMinutes >= durationMinutes) {
        const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);

        availableSlots.push({
          date: currentDate.toISOString().split('T')[0],
          dayName: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
          start: slotStart.toTimeString().slice(0, 5),
          end: slotEnd.toTimeString().slice(0, 5),
          durationMinutes: remainingMinutes
        });
      }
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return availableSlots;
}

function formatEventsForPrompt(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return "No existing events in this time range.";
  }

  return events.map(e => {
    const times = parseEventTime(e);
    if (!times) return null;

    const dateStr = times.start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    const startTime = times.start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    const endTime = times.end.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    return `- ${e.summary || 'Busy'}: ${dateStr} ${startTime} - ${endTime}`;
  }).filter(Boolean).join('\n');
}

function formatSlotsForPrompt(slots: AvailableSlot[]): string {
  if (slots.length === 0) {
    return "No available slots found in the requested time range.";
  }

  return slots.map(s => {
    return `- ${s.dayName}, ${s.date}: ${s.start} - ${s.end} (${s.durationMinutes} minutes available)`;
  }).join('\n');
}

function formatApplicationsForPrompt(applications: ApplicationData[]): string {
  if (applications.length === 0) {
    return "No active applications found.";
  }

  return applications.map(app => {
    const matchScore = app.match_score ? `${app.match_score}% match` : 'No match score';
    return `- ${app.company_name} - ${app.job_title} (${app.status}, ${matchScore})`;
  }).join('\n');
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestData: ScheduleRequest = await req.json();
    const { userMessage, duration, dateRange, timezone, userId, resumeIds, conversationHistory = [] } = requestData;

    if (!userMessage || !duration || !dateRange) {
      throw new Error("Missing required fields: userMessage, duration, dateRange");
    }

    const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID");

    // Fetch user's applications if userId provided (filtered by resumeIds if available)
    let applications: ApplicationData[] = [];
    if (userId) {
      applications = await fetchUserApplications(userId, resumeIds);
      console.log(`Fetched ${applications.length} applications for user${resumeIds?.length ? ` (filtered by ${resumeIds.length} resumes)` : ''}`);
    }

    // Get events from both sources
    let googleEvents: CalendarEvent[] = [];
    let databaseInterviews: DatabaseInterview[] = [];

    // Fetch Google Calendar events
    if (calendarId) {
      try {
        const accessToken = await getGoogleAccessToken();
        googleEvents = await fetchCalendarEvents(accessToken, calendarId, dateRange.start, dateRange.end);
      } catch (calendarError) {
        console.error('Google Calendar fetch error:', calendarError);
      }
    }

    // Fetch interviews from database
    try {
      databaseInterviews = await fetchDatabaseInterviews(dateRange.start, dateRange.end, userId);
      console.log(`Fetched ${databaseInterviews.length} interviews from database`);
    } catch (dbError) {
      console.error('Database fetch error:', dbError);
    }

    // Combine both sources
    const databaseEvents = convertInterviewsToEvents(databaseInterviews);
    const allEvents = [...googleEvents, ...databaseEvents];

    // Remove duplicates
    const events = allEvents.filter((event, index, self) => {
      const eventStart = new Date(event.start.dateTime || event.start.date || '').getTime();

      const isDuplicate = self.slice(0, index).some(other => {
        const otherStart = new Date(other.start.dateTime || other.start.date || '').getTime();
        return Math.abs(eventStart - otherStart) < 5 * 60 * 1000;
      });

      return !isDuplicate;
    });

    console.log(`Total unique events: ${events.length}`);

    // Find available slots
    const availableSlots = findAvailableSlots(events, dateRange, duration, timezone);

    // Build the system prompt with application context
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = `You are an intelligent interview scheduling assistant for a recruitment management system. Your job is to help users schedule interviews for their job applications.

TODAY'S DATE: ${todayStr}
USER'S TIMEZONE: ${timezone}
REQUESTED INTERVIEW DURATION: ${duration} minutes

USER'S ACTIVE JOB APPLICATIONS:
${formatApplicationsForPrompt(applications)}

SCHEDULING CONSTRAINTS:
- Only suggest slots between 9:00 AM and 6:00 PM
- Ensure the full ${duration}-minute interview fits within the slot
- Prefer slots with buffer time before/after existing meetings (15+ minutes)
- Avoid back-to-back scheduling when possible
- Consider the user's preferences expressed in their message

EXISTING CALENDAR EVENTS (times to AVOID):
${formatEventsForPrompt(events)}

AVAILABLE SLOTS (times that are FREE):
${formatSlotsForPrompt(availableSlots)}

CRITICAL RULE - YOU MUST FOLLOW THIS:

Before suggesting ANY time slots, you MUST check if the user mentioned a specific company name from the applications list above.

**IF NO COMPANY MENTIONED** (e.g., "find a slot", "schedule an interview", "propose times"):
You MUST ask which company. Format the response nicely with each application on a new line.

**IF COMPANY IS MENTIONED** (e.g., "schedule for Google", "interview at Microsoft"):
Find the matching application and suggest 2-3 time slots.

RESPONSE FORMAT - ONLY VALID JSON, NO MARKDOWN:

When asking for company:
{"message": "I'd be happy to help schedule an interview! Which company would you like to schedule for?\\n\\n1. [Company1] - [JobTitle1]\\n2. [Company2] - [JobTitle2]\\n3. [Company3] - [JobTitle3]\\n\\nJust tell me the company name!", "suggestedSlots": []}

When suggesting slots:
{"message": "Here are some great times for your [JobTitle] interview at [Company]:", "suggestedSlots": [{"date": "YYYY-MM-DD", "startTime": "HH:mm", "endTime": "HH:mm", "datetime": "YYYY-MM-DDTHH:mm:00", "reason": "Brief reason", "applicationId": "uuid-from-list", "companyName": "Company", "jobTitle": "Title"}]}

IMPORTANT:
- Use \\n for line breaks in the message (escaped newlines for JSON)
- Number the applications (1. 2. 3.) for easy selection
- Keep messages friendly and concise
- Always include applicationId from the applications list when suggesting slots
- RESPOND WITH ONLY VALID JSON - no markdown code blocks, no extra text`;

    // Prepare messages for Claude
    const messages = [
      ...conversationHistory.slice(-8).map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      })),
      { role: 'user' as const, content: userMessage }
    ];

    // Call Claude
    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    // Parse Claude's response
    let assistantResponse: { message: string; suggestedSlots: SuggestedSlot[] };

    try {
      let jsonText = content.text.trim();
      console.log('Raw Claude response:', jsonText.substring(0, 200));

      // Handle markdown code blocks
      if (jsonText.includes("```")) {
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1].trim();
        }
      }

      // Extract JSON object
      const firstBrace = jsonText.indexOf('{');
      const lastBrace = jsonText.lastIndexOf('}');

      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      }

      assistantResponse = JSON.parse(jsonText);
      console.log('Parsed successfully, slots:', assistantResponse.suggestedSlots?.length);

      // Validate response structure
      if (!assistantResponse.message) {
        assistantResponse.message = "Here are some available times:";
      }
      if (!Array.isArray(assistantResponse.suggestedSlots)) {
        assistantResponse.suggestedSlots = [];
      }
    } catch (parseError: any) {
      console.error('Failed to parse Claude response:', parseError.message);
      console.error('Raw text was:', content.text.substring(0, 500));

      // Try to extract a meaningful message from the raw response
      let fallbackMessage = content.text.trim();

      // If it looks like it contains a question about company, use it
      if (fallbackMessage.toLowerCase().includes('which company') ||
          fallbackMessage.toLowerCase().includes('what company')) {
        // Clean up any JSON artifacts
        fallbackMessage = fallbackMessage.replace(/[{}"\[\]]/g, '').trim();
      } else {
        fallbackMessage = "I couldn't process that request. Could you please specify which company you'd like to schedule an interview for?";
      }

      assistantResponse = {
        message: fallbackMessage,
        suggestedSlots: []
      };
    }

    return new Response(JSON.stringify(assistantResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in ai-schedule-interview:", error);

    return new Response(
      JSON.stringify({
        error: error.message,
        message: "I'm sorry, I encountered an error while checking availability. Please try again or select a time manually.",
        suggestedSlots: []
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});