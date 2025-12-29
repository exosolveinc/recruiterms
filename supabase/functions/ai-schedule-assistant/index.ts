import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { JWT } from "npm:google-auth-library@9.0.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.24.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ScheduleRequest {
  userMessage: string;
  duration: number;
  dateRange: {
    start: string;
    end: string;
  };
  timezone: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}

interface SuggestedSlot {
  date: string;
  startTime: string;
  endTime: string;
  datetime: string;
  reason: string;
}

interface AvailableSlot {
  date: string;
  dayName: string;
  start: string;
  end: string;
  durationMinutes: number;
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

  // Working hours: 12:00 PM to 6:00 PM
  const workStartHour = 12;
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

    // Skip weekends (0 = Sunday, 6 = Saturday)
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
      // If there's a gap before this busy time
      if (busy.start > slotStart) {
        const gapMinutes = (busy.start.getTime() - slotStart.getTime()) / (1000 * 60);

        // Check if the gap is big enough for the requested duration + 15 min buffer
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

      // Move slot start to after this busy time (with 15 min buffer)
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestData: ScheduleRequest = await req.json();
    const { userMessage, duration, dateRange, timezone, conversationHistory = [] } = requestData;

    // Validate inputs
    if (!userMessage || !duration || !dateRange) {
      throw new Error("Missing required fields: userMessage, duration, dateRange");
    }

    const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID");
    if (!calendarId) {
      throw new Error("GOOGLE_CALENDAR_ID not configured");
    }

    // Get Google Calendar events
    let events: CalendarEvent[] = [];
    let availableSlots: AvailableSlot[] = [];

    try {
      const accessToken = await getGoogleAccessToken();
      events = await fetchCalendarEvents(accessToken, calendarId, dateRange.start, dateRange.end);
      availableSlots = findAvailableSlots(events, dateRange, duration, timezone);
    } catch (calendarError) {
      console.error('Calendar fetch error:', calendarError);
      // Continue without calendar data - AI will work with limited info
    }

    // Build the system prompt
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = `You are an intelligent interview scheduling assistant. Your job is to help users find optimal interview time slots based on calendar availability.

TODAY'S DATE: ${todayStr}
USER'S TIMEZONE: ${timezone}
REQUESTED INTERVIEW DURATION: ${duration} minutes

SCHEDULING CONSTRAINTS:
- Only suggest slots between 12:00 PM and 6:00 PM
- Ensure the full ${duration}-minute interview fits within the slot
- Prefer slots with buffer time before/after existing meetings (15+ minutes)
- Avoid back-to-back scheduling when possible
- Consider the user's preferences expressed in their message (specific days, times, etc.)

EXISTING CALENDAR EVENTS (times to AVOID):
${formatEventsForPrompt(events)}

AVAILABLE SLOTS (times that are FREE):
${formatSlotsForPrompt(availableSlots)}

INSTRUCTIONS:
1. Analyze the user's request to understand their scheduling preferences
2. Select the best 1-3 slots from the available options that match their request
3. Provide a friendly, helpful response explaining your recommendations
4. If no slots match their request, suggest alternatives or ask for clarification

You MUST respond with valid JSON in this exact format:
{
  "message": "Your friendly conversational response here",
  "suggestedSlots": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "datetime": "YYYY-MM-DDTHH:mm:00",
      "reason": "Brief explanation of why this slot is good"
    }
  ]
}

If you cannot find suitable slots, return an empty suggestedSlots array and explain in the message.`;

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

      // Handle markdown code blocks
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }

      assistantResponse = JSON.parse(jsonText);

      // Validate response structure
      if (!assistantResponse.message) {
        assistantResponse.message = "Here are some available times:";
      }
      if (!Array.isArray(assistantResponse.suggestedSlots)) {
        assistantResponse.suggestedSlots = [];
      }
    } catch (parseError) {
      console.error('Failed to parse Claude response:', content.text);
      assistantResponse = {
        message: content.text,
        suggestedSlots: []
      };
    }

    return new Response(JSON.stringify(assistantResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in ai-schedule-assistant:", error);

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
