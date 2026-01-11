import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Gmail API scopes needed
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "authorize";

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI");

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Google OAuth credentials not configured");
    }

    // Get candidateId from query params or body
    const candidateId = url.searchParams.get("candidateId");

    // Handle different OAuth actions
    switch (action) {
      case "authorize": {
        // Generate authorization URL
        // Include candidateId in state for callback
        const stateObj = {
          nonce: crypto.randomUUID(),
          candidateId: candidateId || null,
        };
        const state = btoa(JSON.stringify(stateObj));

        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", GMAIL_SCOPES.join(" "));
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");
        authUrl.searchParams.set("state", state);

        return new Response(
          JSON.stringify({ authUrl: authUrl.toString(), state }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "callback": {
        // Exchange authorization code for tokens
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
          throw new Error("Missing authorization header");
        }

        const body = await req.json();
        const { code, state } = body;
        // candidateId can come from body or decoded from state
        let callbackCandidateId = body.candidateId;

        // Try to decode candidateId from state if not in body
        if (!callbackCandidateId && state) {
          try {
            const stateObj = JSON.parse(atob(state));
            callbackCandidateId = stateObj.candidateId;
          } catch (e) {
            // State might be old format (just a UUID), ignore
          }
        }

        if (!code) {
          throw new Error("Authorization code is required");
        }

        // Exchange code for tokens
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.text();
          console.error("Token exchange failed:", errorData);
          throw new Error("Failed to exchange authorization code");
        }

        const tokens = await tokenResponse.json();

        // Get user info from Google
        const userInfoResponse = await fetch(
          "https://www.googleapis.com/oauth2/v2/userinfo",
          {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          }
        );

        if (!userInfoResponse.ok) {
          throw new Error("Failed to get user info");
        }

        const userInfo = await userInfoResponse.json();

        // Initialize Supabase client
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Get user ID from auth header
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
          throw new Error("Invalid authorization token");
        }

        // Calculate token expiration
        const tokenExpiresAt = new Date(
          Date.now() + (tokens.expires_in || 3600) * 1000
        ).toISOString();

        // Save or update Gmail connection for this candidate
        // Look for existing connection for this user+candidate combo
        let query = supabase
          .from("gmail_connections")
          .select("id")
          .eq("user_id", user.id);

        if (callbackCandidateId) {
          query = query.eq("candidate_id", callbackCandidateId);
        } else {
          query = query.is("candidate_id", null);
        }

        const { data: existingConnection } = await query.single();

        if (existingConnection) {
          // Update existing connection
          const { error: updateError } = await supabase
            .from("gmail_connections")
            .update({
              google_email: userInfo.email,
              google_user_id: userInfo.id,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token || null,
              token_expires_at: tokenExpiresAt,
              scopes: GMAIL_SCOPES,
              is_active: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingConnection.id);

          if (updateError) {
            throw new Error(`Failed to update connection: ${updateError.message}`);
          }
        } else {
          // Create new connection
          const { error: insertError } = await supabase
            .from("gmail_connections")
            .insert({
              user_id: user.id,
              candidate_id: callbackCandidateId || null,
              google_email: userInfo.email,
              google_user_id: userInfo.id,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token || null,
              token_expires_at: tokenExpiresAt,
              scopes: GMAIL_SCOPES,
              is_active: true,
            });

          if (insertError) {
            throw new Error(`Failed to save connection: ${insertError.message}`);
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            email: userInfo.email,
            name: userInfo.name,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "disconnect": {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
          throw new Error("Missing authorization header");
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
          throw new Error("Invalid authorization token");
        }

        // Deactivate the connection (keep data for reference)
        // If candidateId is provided, only disconnect that specific connection
        let disconnectQuery = supabase
          .from("gmail_connections")
          .update({
            is_active: false,
            access_token: null,
            refresh_token: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user.id);

        if (candidateId) {
          disconnectQuery = disconnectQuery.eq("candidate_id", candidateId);
        }

        const { error: updateError } = await disconnectQuery;

        if (updateError) {
          throw new Error(`Failed to disconnect: ${updateError.message}`);
        }

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "status": {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
          throw new Error("Missing authorization header");
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
          throw new Error("Invalid authorization token");
        }

        const { data: connection } = await supabase
          .from("gmail_connections")
          .select("google_email, is_active, last_sync_at, last_sync_status, emails_synced_count, auto_sync_enabled")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .single();

        return new Response(
          JSON.stringify({
            connected: !!connection,
            ...(connection || {}),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "refresh": {
        // Refresh access token using refresh token
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
          throw new Error("Missing authorization header");
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
          throw new Error("Invalid authorization token");
        }

        const { data: connection } = await supabase
          .from("gmail_connections")
          .select("id, refresh_token")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .single();

        if (!connection || !connection.refresh_token) {
          throw new Error("No refresh token available");
        }

        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
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
        const tokenExpiresAt = new Date(
          Date.now() + (tokens.expires_in || 3600) * 1000
        ).toISOString();

        await supabase
          .from("gmail_connections")
          .update({
            access_token: tokens.access_token,
            token_expires_at: tokenExpiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id);

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
