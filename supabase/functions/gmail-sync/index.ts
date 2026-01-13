import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import OpenAI from "https://cdn.jsdelivr.net/npm/openai@4/+esm";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    }>;
  };
  internalDate: string;
}

// Decode base64url encoded string
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  const paddedBase64 = padding ? base64 + "=".repeat(4 - padding) : base64;
  try {
    return atob(paddedBase64);
  } catch {
    return "";
  }
}

// Extract email body from Gmail message
function extractEmailBody(payload: GmailMessage["payload"]): string {
  // Check direct body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Check parts for text/plain or text/html
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      // Check nested parts
      if (part.parts) {
        for (const nestedPart of part.parts) {
          if (nestedPart.mimeType === "text/plain" && nestedPart.body?.data) {
            return decodeBase64Url(nestedPart.body.data);
          }
        }
      }
    }
    // Fallback to HTML
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        // Strip HTML tags for plain text
        return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  return "";
}

// Get header value from Gmail message
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

// Check if email is likely a job email based on keywords
function isLikelyJobEmail(subject: string, body: string, searchKeywords: string[]): boolean {
  const content = `${subject} ${body}`.toLowerCase();

  // Must contain at least one search keyword
  const hasKeyword = searchKeywords.some((keyword) =>
    content.includes(keyword.toLowerCase())
  );

  if (!hasKeyword) return false;

  // Additional job-related patterns
  const jobPatterns = [
    /\b(job|position|opportunity|opening|role)\b/i,
    /\b(w2|c2c|1099|corp.?to.?corp)\b/i,
    /\b(remote|hybrid|onsite|on-site)\b/i,
    /\b(contract|full.?time|part.?time)\b/i,
    /\b(rate|salary|compensation|pay)\b/i,
    /\b(years?.?(?:of)?.?experience|yrs)\b/i,
    /\b(skills?|requirements?|qualifications?)\b/i,
    /\b(client|staffing|consulting|agency)\b/i,
  ];

  const matchCount = jobPatterns.filter((pattern) => pattern.test(content)).length;
  return matchCount >= 2;
}

// Refresh access token if needed
async function refreshTokenIfNeeded(
  supabase: any,
  connection: any,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();

  // Refresh if token expires within 5 minutes
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    throw new Error("Token expired and no refresh token available");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error("Failed to refresh token");
  }

  const tokens = await tokenResponse.json();
  const tokenExpiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

  await supabase
    .from("gmail_connections")
    .update({
      access_token: tokens.access_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return tokens.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

  let syncLogId: string | null = null;
  let userId: string | null = null;
  let connectionId: string | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Missing authorization header");
    }

    const { syncType = "manual", maxEmails = 50, syncAll = false, candidateId = null, connectionId: requestConnectionId = null } = await req.json().catch(() => ({}));

    // Get user from auth token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      throw new Error("Invalid authorization token");
    }

    userId = user.id;

    let connection;
    let connError;

    // If connectionId is provided, use it directly
    if (requestConnectionId) {
      const result = await supabase
        .from("gmail_connections")
        .select("*")
        .eq("id", requestConnectionId)
        .eq("user_id", user.id)
        .eq("is_active", true)
        .single();
      connection = result.data;
      connError = result.error;
    } else {
      // Get Gmail connection - for specific candidate if provided
      let connectionQuery = supabase
        .from("gmail_connections")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (candidateId) {
        connectionQuery = connectionQuery.eq("candidate_id", candidateId);
      } else {
        connectionQuery = connectionQuery.is("candidate_id", null);
      }

      const result = await connectionQuery.single();
      connection = result.data;
      connError = result.error;
    }

    if (connError || !connection) {
      throw new Error("Gmail not connected. Please connect your Gmail account first.");
    }

    connectionId = connection.id;

    // Create sync log
    const { data: syncLog, error: logError } = await supabase
      .from("gmail_sync_logs")
      .insert({
        gmail_connection_id: connection.id,
        user_id: user.id,
        candidate_id: candidateId || connection.candidate_id,
        sync_type: syncType,
        status: "running",
      })
      .select("id")
      .single();

    if (logError || !syncLog) {
      console.error("Failed to create sync log:", logError);
    } else {
      syncLogId = syncLog.id;
    }

    // Refresh token if needed
    const accessToken = await refreshTokenIfNeeded(
      supabase,
      connection,
      clientId,
      clientSecret
    );

    // Build Gmail search query
    const searchKeywords = connection.search_keywords || [
      "position", "opportunity", "job", "W2", "C2C", "1099", "contract", "recruiter", "staffing"
    ];

    // Search for emails with job-related keywords
    const searchQuery = searchKeywords.map((k: string) => k).join(" OR ");

    // Fetch messages from Gmail with pagination support
    let messages: any[] = [];
    let nextPageToken: string | null = null;
    const targetEmailCount = syncAll ? 500 : maxEmails; // Limit to 500 for "sync all" to prevent timeout

    // Use history ID for incremental sync if available
    if (syncType === "incremental" && connection.gmail_history_id) {
      // Use history API for incremental sync
      const historyUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
      historyUrl.searchParams.set("startHistoryId", connection.gmail_history_id);
      historyUrl.searchParams.set("historyTypes", "messageAdded");

      const historyResponse = await fetch(historyUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (historyResponse.ok) {
        const historyData = await historyResponse.json();
        // Process history results...
        // For now, fall back to regular search
      }
    }

    // Paginate through Gmail API to get all matching emails
    do {
      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("q", searchQuery);
      listUrl.searchParams.set("maxResults", String(Math.min(100, targetEmailCount - messages.length)));

      if (nextPageToken) {
        listUrl.searchParams.set("pageToken", nextPageToken);
      }

      const listResponse = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!listResponse.ok) {
        const errorText = await listResponse.text();
        console.error("Gmail API error:", errorText);
        throw new Error("Failed to fetch emails from Gmail");
      }

      const listData = await listResponse.json();
      const pageMessages = listData.messages || [];
      messages = messages.concat(pageMessages);
      nextPageToken = listData.nextPageToken || null;

      console.log(`Fetched ${messages.length} emails so far...`);

    } while (nextPageToken && messages.length < targetEmailCount);

    console.log(`Found ${messages.length} potential job emails`);

    // Get already processed email IDs
    const { data: processedEmails } = await supabase
      .from("gmail_processed_emails")
      .select("gmail_message_id")
      .eq("gmail_connection_id", connection.id);

    const processedIds = new Set(processedEmails?.map((e: any) => e.gmail_message_id) || []);

    // Filter out already processed emails
    const newMessages = messages.filter((m: any) => !processedIds.has(m.id));
    console.log(`${newMessages.length} new emails to process`);

    // Initialize OpenAI
    const openai = new OpenAI({ apiKey: openaiKey });

    let emailsFound = messages.length;
    let emailsParsed = 0;
    let emailsSkipped = 0;
    let jobsCreated = 0;
    const errors: string[] = [];

    // Process each new email (limit processing to targetEmailCount)
    for (const msg of newMessages.slice(0, targetEmailCount)) {
      try {
        // Fetch full message
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!msgResponse.ok) {
          emailsSkipped++;
          continue;
        }

        const message: GmailMessage = await msgResponse.json();
        const headers = message.payload.headers;

        const subject = getHeader(headers, "Subject");
        const from = getHeader(headers, "From");
        const date = getHeader(headers, "Date");
        const body = extractEmailBody(message.payload);

        // Check if this looks like a job email
        if (!isLikelyJobEmail(subject, body, searchKeywords)) {
          // Mark as processed but not a job email
          await supabase.from("gmail_processed_emails").insert({
            gmail_connection_id: connection.id,
            user_id: user.id,
            candidate_id: candidateId || connection.candidate_id,
            gmail_message_id: message.id,
            gmail_thread_id: message.threadId,
            was_job_email: false,
            from_email: from,
            subject: subject,
            received_at: new Date(parseInt(message.internalDate)).toISOString(),
          });
          emailsSkipped++;
          continue;
        }

        // Parse with AI using the existing parse-vendor-email function logic
        const systemPrompt = `You are an expert at extracting job information from recruiter/vendor emails.
These emails typically come from staffing agencies and contain job opportunities with details about:
- The position (title, tech stack, requirements)
- The client company (the actual employer)
- The staffing company (vendor)
- Compensation details
- Location and work arrangement
- Recruiter contact information

Extract all relevant information accurately. Return ONLY valid JSON.`;

        const userPrompt = `Extract job information from this vendor/recruiter email. Return a JSON object with these fields:

{
  "job_title": "string - exact job title",
  "client_company": "string or null - the actual client/employer (e.g., Capital One), NOT the staffing agency",
  "location": "string or null - full location",
  "work_arrangement": "remote" | "hybrid" | "onsite" | "unknown",
  "employment_type": "w2" | "c2c" | "1099" | "full_time" | "contract" | "contract_to_hire" | "part_time" | "unknown",
  "duration": "string or null - contract duration",
  "pay_rate": "string or null - original pay rate text",
  "pay_rate_min": "number or null",
  "pay_rate_max": "number or null",
  "pay_rate_type": "hourly" | "annual" | "monthly" | null,
  "required_skills": ["array of skills"],
  "years_experience": "string or null",
  "certifications": ["array"],
  "special_requirements": "string or null",
  "tech_stack": { "frontend": [], "backend": [], "cloud": [], "other": [] },
  "job_description": "string or null",
  "recruiter_name": "string or null",
  "recruiter_email": "string or null",
  "recruiter_phone": "string or null",
  "recruiter_title": "string or null",
  "vendor_company": "string or null - staffing company name",
  "extraction_confidence": "number 0-1",
  "extraction_errors": []
}

Email Subject: ${subject}
Email From: ${from}

Email Body:
${body.substring(0, 8000)}

Return ONLY the JSON object.`;

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        });

        const content = aiResponse.choices[0]?.message?.content;
        if (!content) {
          throw new Error("No AI response");
        }

        const parsedData = JSON.parse(content);

        if (!parsedData.job_title) {
          // Not a valid job email
          await supabase.from("gmail_processed_emails").insert({
            gmail_connection_id: connection.id,
            user_id: user.id,
            candidate_id: candidateId || connection.candidate_id,
            gmail_message_id: message.id,
            gmail_thread_id: message.threadId,
            was_job_email: false,
            from_email: from,
            subject: subject,
            received_at: new Date(parseInt(message.internalDate)).toISOString(),
            processing_error: "Could not extract job title",
          });
          emailsSkipped++;
          continue;
        }

        // Check/create vendor
        let vendorId = null;
        if (parsedData.vendor_company) {
          const { data: existingVendor } = await supabase
            .from("vendors")
            .select("id")
            .eq("user_id", user.id)
            .eq("company_name", parsedData.vendor_company)
            .single();

          if (existingVendor) {
            vendorId = existingVendor.id;
          } else {
            const { data: newVendor } = await supabase
              .from("vendors")
              .insert({
                user_id: user.id,
                company_name: parsedData.vendor_company,
                emails_received: 1,
                jobs_posted: 1,
              })
              .select("id")
              .single();

            if (newVendor) {
              vendorId = newVendor.id;
            }
          }
        }

        // Check/create vendor contact
        let vendorContactId = null;
        if (vendorId && parsedData.recruiter_email) {
          const { data: existingContact } = await supabase
            .from("vendor_contacts")
            .select("id")
            .eq("vendor_id", vendorId)
            .eq("email", parsedData.recruiter_email)
            .single();

          if (existingContact) {
            vendorContactId = existingContact.id;
          } else {
            const { data: newContact } = await supabase
              .from("vendor_contacts")
              .insert({
                vendor_id: vendorId,
                user_id: user.id,
                name: parsedData.recruiter_name || "Unknown",
                email: parsedData.recruiter_email,
                phone: parsedData.recruiter_phone,
                title: parsedData.recruiter_title,
                emails_sent: 1,
                last_contact_at: new Date().toISOString(),
              })
              .select("id")
              .single();

            if (newContact) {
              vendorContactId = newContact.id;
            }
          }
        }

        // Save the vendor job email
        const { data: savedJob, error: saveError } = await supabase
          .from("vendor_job_emails")
          .insert({
            user_id: user.id,
            candidate_id: candidateId || connection.candidate_id,
            gmail_connection_id: connection.id,
            vendor_id: vendorId,
            vendor_contact_id: vendorContactId,
            email_id: message.id,
            email_subject: subject,
            email_from: from,
            email_received_at: new Date(parseInt(message.internalDate)).toISOString(),
            email_body_raw: body,
            job_title: parsedData.job_title,
            client_company: parsedData.client_company,
            location: parsedData.location,
            work_arrangement: parsedData.work_arrangement || "unknown",
            employment_type: parsedData.employment_type || "unknown",
            duration: parsedData.duration,
            pay_rate: parsedData.pay_rate,
            pay_rate_min: parsedData.pay_rate_min,
            pay_rate_max: parsedData.pay_rate_max,
            pay_rate_type: parsedData.pay_rate_type,
            required_skills: parsedData.required_skills || [],
            years_experience: parsedData.years_experience,
            certifications: parsedData.certifications || [],
            special_requirements: parsedData.special_requirements,
            tech_stack: parsedData.tech_stack || {},
            job_description: parsedData.job_description,
            recruiter_name: parsedData.recruiter_name,
            recruiter_email: parsedData.recruiter_email,
            recruiter_phone: parsedData.recruiter_phone,
            recruiter_title: parsedData.recruiter_title,
            extraction_confidence: parsedData.extraction_confidence || 0.8,
            extraction_errors: parsedData.extraction_errors || [],
            status: "new",
          })
          .select("id")
          .single();

        if (saveError) {
          throw saveError;
        }

        // Mark email as processed
        await supabase.from("gmail_processed_emails").insert({
          gmail_connection_id: connection.id,
          user_id: user.id,
          candidate_id: candidateId || connection.candidate_id,
          gmail_message_id: message.id,
          gmail_thread_id: message.threadId,
          was_job_email: true,
          vendor_job_id: savedJob?.id,
          from_email: from,
          subject: subject,
          received_at: new Date(parseInt(message.internalDate)).toISOString(),
        });

        emailsParsed++;
        jobsCreated++;
      } catch (emailError: any) {
        console.error(`Error processing email ${msg.id}:`, emailError);
        errors.push(`Email ${msg.id}: ${emailError.message}`);
        emailsSkipped++;
      }
    }

    // Get new history ID for future incremental syncs
    const profileResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    let newHistoryId = connection.gmail_history_id;
    if (profileResponse.ok) {
      const profileData = await profileResponse.json();
      newHistoryId = profileData.historyId;
    }

    // Update connection with sync info
    await supabase
      .from("gmail_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: errors.length > 0 ? "partial" : "completed",
        last_sync_error: errors.length > 0 ? errors.join("; ") : null,
        emails_synced_count: (connection.emails_synced_count || 0) + jobsCreated,
        gmail_history_id: newHistoryId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    // Update sync log
    if (syncLogId) {
      await supabase
        .from("gmail_sync_logs")
        .update({
          completed_at: new Date().toISOString(),
          status: errors.length > 0 ? "partial" : "completed",
          emails_found: emailsFound,
          emails_parsed: emailsParsed,
          emails_skipped: emailsSkipped,
          jobs_created: jobsCreated,
          error_message: errors.length > 0 ? errors.join("; ") : null,
          new_history_id: newHistoryId,
        })
        .eq("id", syncLogId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        emailsFound,
        emailsParsed,
        emailsSkipped,
        jobsCreated,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Sync error:", error);

    // Update sync log with error
    if (syncLogId) {
      await supabase
        .from("gmail_sync_logs")
        .update({
          completed_at: new Date().toISOString(),
          status: "failed",
          error_message: error.message,
        })
        .eq("id", syncLogId);
    }

    // Update connection with error
    if (connectionId) {
      await supabase
        .from("gmail_connections")
        .update({
          last_sync_status: "failed",
          last_sync_error: error.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionId);
    }

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
