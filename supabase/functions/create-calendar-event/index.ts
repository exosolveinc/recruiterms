import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { JWT } from "npm:google-auth-library@9.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CalendarEventRequest {
  action: 'create' | 'update' | 'delete';
  eventId?: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  timezone: string;
  location?: string;
  attendees?: string[];
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestData: CalendarEventRequest = await req.json();
    const { action, eventId, title, description, startTime, endTime, timezone, location, attendees } = requestData;

    // Get service account credentials from environment
    const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID");

    if (!serviceAccountJson) {
      throw new Error("Google service account credentials not configured");
    }

    if (!calendarId) {
      throw new Error("Google Calendar ID not configured");
    }

    const credentials: ServiceAccountCredentials = JSON.parse(serviceAccountJson);

    // Create JWT client for authentication
    const jwtClient = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    // Get access token
    const tokens = await jwtClient.authorize();
    const accessToken = tokens.access_token;

    if (!accessToken) {
      throw new Error("Failed to obtain access token");
    }

    const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    let response;
    let result;

    if (action === 'create') {
      // Create event
      const event = {
        summary: title,
        description: description,
        location: location,
        start: {
          dateTime: startTime,
          timeZone: timezone,
        },
        end: {
          dateTime: endTime,
          timeZone: timezone,
        },
        attendees: attendees?.map(email => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 30 },
          ],
        },
      };

      response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Google Calendar API error:', errorText);
        throw new Error(`Failed to create event: ${response.status}`);
      }

      result = await response.json();

      return new Response(JSON.stringify({
        success: true,
        eventId: result.id,
        htmlLink: result.htmlLink,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } else if (action === 'update' && eventId) {
      // Update event
      const event = {
        summary: title,
        description: description,
        location: location,
        start: {
          dateTime: startTime,
          timeZone: timezone,
        },
        end: {
          dateTime: endTime,
          timeZone: timezone,
        },
        attendees: attendees?.map(email => ({ email })),
      };

      response = await fetch(`${baseUrl}/${eventId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Google Calendar API error:', errorText);
        throw new Error(`Failed to update event: ${response.status}`);
      }

      result = await response.json();

      return new Response(JSON.stringify({
        success: true,
        eventId: result.id,
        htmlLink: result.htmlLink,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } else if (action === 'delete' && eventId) {
      // Delete event
      response = await fetch(`${baseUrl}/${eventId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete event: ${response.status}`);
      }

      return new Response(JSON.stringify({
        success: true,
        deleted: true,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Invalid action or missing eventId for update/delete");

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
