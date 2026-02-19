import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/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";

interface SlackNotificationRequest {
  event_type: 'scheduled' | 'rescheduled';
  title: string;
  interview_type: string;
  scheduled_at: string;
  duration_minutes: number;
  timezone: string;
  interviewer_name?: string;
  meeting_link?: string;
  location?: string;
  notes?: string;
  job_title?: string;
  company_name?: string;
  candidate_name?: string;
}

function formatInterviewType(type: string): string {
  const types: Record<string, string> = {
    'phone': 'Phone Interview',
    'video': 'Video Interview',
    'onsite': 'Onsite Interview',
    'technical': 'Technical Interview',
    'behavioral': 'Behavioral Interview',
    'panel': 'Panel Interview',
    'other': 'Interview',
  };
  return types[type] || type;
}

function formatDateTime(isoString: string, timezone: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
      timeZoneName: 'short',
    });
  } catch {
    return isoString;
  }
}

function buildSlackBlocks(data: SlackNotificationRequest) {
  const isRescheduled = data.event_type === 'rescheduled';
  const emoji = isRescheduled ? ':calendar:' : ':date:';
  const headerText = isRescheduled ? 'Interview Rescheduled' : 'New Interview Scheduled';

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} ${headerText}`,
        emoji: true,
      },
    },
  ];

  // Job + company + candidate section
  const jobLine = data.job_title && data.company_name
    ? `*${data.job_title}* at *${data.company_name}*`
    : data.job_title
      ? `*${data.job_title}*`
      : data.title;

  let sectionText = jobLine;
  if (data.candidate_name) {
    sectionText += `\nCandidate: *${data.candidate_name}*`;
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: sectionText,
    },
  });

  // Date/time, duration, type fields
  blocks.push({
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text: `*When:*\n${formatDateTime(data.scheduled_at, data.timezone)}`,
      },
      {
        type: "mrkdwn",
        text: `*Duration:*\n${data.duration_minutes} minutes`,
      },
      {
        type: "mrkdwn",
        text: `*Type:*\n${formatInterviewType(data.interview_type)}`,
      },
    ],
  });

  // Interviewer, meeting link, location
  const detailFields: any[] = [];

  if (data.interviewer_name) {
    detailFields.push({
      type: "mrkdwn",
      text: `*Interviewer:*\n${data.interviewer_name}`,
    });
  }

  if (data.meeting_link) {
    detailFields.push({
      type: "mrkdwn",
      text: `*Meeting Link:*\n<${data.meeting_link}|Join Meeting>`,
    });
  }

  if (data.location) {
    detailFields.push({
      type: "mrkdwn",
      text: `*Location:*\n${data.location}`,
    });
  }

  if (detailFields.length > 0) {
    blocks.push({
      type: "section",
      fields: detailFields,
    });
  }

  // Notes + footer
  const contextElements: any[] = [];

  if (data.notes) {
    contextElements.push({
      type: "mrkdwn",
      text: `:memo: ${data.notes}`,
    });
  }

  contextElements.push({
    type: "mrkdwn",
    text: "Sent via *RecruiterMS*",
  });

  blocks.push({
    type: "context",
    elements: contextElements,
  });

  return blocks;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const data: SlackNotificationRequest = await req.json();

    const blocks = buildSlackBlocks(data);

    const slackPayload = {
      blocks,
      text: data.event_type === 'rescheduled'
        ? `Interview Rescheduled: ${data.title}`
        : `New Interview Scheduled: ${data.title}`,
    };

    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Slack webhook error:", errorText);
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
