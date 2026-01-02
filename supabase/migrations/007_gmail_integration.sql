-- ============================================================================
-- GMAIL INTEGRATION TABLE
-- ============================================================================
-- This migration creates tables for storing Gmail OAuth tokens and sync state
-- ============================================================================

-- Gmail connections table - stores OAuth tokens
CREATE TABLE IF NOT EXISTS gmail_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Google account info
  google_email TEXT NOT NULL,
  google_user_id TEXT,

  -- OAuth tokens (encrypted in production)
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,

  -- Scopes granted
  scopes TEXT[],

  -- Sync settings
  is_active BOOLEAN DEFAULT TRUE,
  auto_sync_enabled BOOLEAN DEFAULT FALSE,
  sync_frequency_minutes INTEGER DEFAULT 60,

  -- Search filters for vendor emails
  search_keywords TEXT[] DEFAULT ARRAY['position', 'opportunity', 'job', 'W2', 'C2C', '1099', 'contract', 'recruiter', 'staffing'],
  exclude_senders TEXT[] DEFAULT '{}'::TEXT[],

  -- Last sync info
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_error TEXT,
  emails_synced_count INTEGER DEFAULT 0,

  -- History ID for incremental sync
  gmail_history_id TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One Gmail connection per user
  UNIQUE(user_id)
);

-- Gmail sync log - tracks each sync operation
CREATE TABLE IF NOT EXISTS gmail_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_connection_id UUID NOT NULL REFERENCES gmail_connections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Sync details
  sync_type TEXT NOT NULL CHECK (sync_type IN ('full', 'incremental', 'manual')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Results
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  emails_found INTEGER DEFAULT 0,
  emails_parsed INTEGER DEFAULT 0,
  emails_skipped INTEGER DEFAULT 0,
  jobs_created INTEGER DEFAULT 0,

  -- Errors
  error_message TEXT,
  error_details JSONB,

  -- New history ID after sync
  new_history_id TEXT
);

-- Processed emails - tracks which emails have been processed to avoid duplicates
CREATE TABLE IF NOT EXISTS gmail_processed_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_connection_id UUID NOT NULL REFERENCES gmail_connections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Email identifiers
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,

  -- Processing result
  was_job_email BOOLEAN DEFAULT FALSE,
  vendor_job_id UUID REFERENCES vendor_job_emails(id) ON DELETE SET NULL,

  -- Email metadata (for quick filtering)
  from_email TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,

  -- Processing info
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_error TEXT,

  -- Unique constraint to prevent duplicates
  UNIQUE(gmail_connection_id, gmail_message_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_gmail_connections_user_id ON gmail_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_connections_google_email ON gmail_connections(google_email);
CREATE INDEX IF NOT EXISTS idx_gmail_connections_is_active ON gmail_connections(is_active);

CREATE INDEX IF NOT EXISTS idx_gmail_sync_logs_connection_id ON gmail_sync_logs(gmail_connection_id);
CREATE INDEX IF NOT EXISTS idx_gmail_sync_logs_user_id ON gmail_sync_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_sync_logs_started_at ON gmail_sync_logs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_processed_emails_connection_id ON gmail_processed_emails(gmail_connection_id);
CREATE INDEX IF NOT EXISTS idx_gmail_processed_emails_message_id ON gmail_processed_emails(gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_gmail_processed_emails_from_email ON gmail_processed_emails(from_email);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_processed_emails ENABLE ROW LEVEL SECURITY;

-- Gmail connections policies
DROP POLICY IF EXISTS "Users can view own gmail connections" ON gmail_connections;
CREATE POLICY "Users can view own gmail connections"
  ON gmail_connections FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own gmail connections" ON gmail_connections;
CREATE POLICY "Users can insert own gmail connections"
  ON gmail_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own gmail connections" ON gmail_connections;
CREATE POLICY "Users can update own gmail connections"
  ON gmail_connections FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own gmail connections" ON gmail_connections;
CREATE POLICY "Users can delete own gmail connections"
  ON gmail_connections FOR DELETE
  USING (auth.uid() = user_id);

-- Gmail sync logs policies
DROP POLICY IF EXISTS "Users can view own sync logs" ON gmail_sync_logs;
CREATE POLICY "Users can view own sync logs"
  ON gmail_sync_logs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own sync logs" ON gmail_sync_logs;
CREATE POLICY "Users can insert own sync logs"
  ON gmail_sync_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Gmail processed emails policies
DROP POLICY IF EXISTS "Users can view own processed emails" ON gmail_processed_emails;
CREATE POLICY "Users can view own processed emails"
  ON gmail_processed_emails FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own processed emails" ON gmail_processed_emails;
CREATE POLICY "Users can insert own processed emails"
  ON gmail_processed_emails FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_gmail_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gmail_connections_updated_at ON gmail_connections;
CREATE TRIGGER gmail_connections_updated_at
  BEFORE UPDATE ON gmail_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_gmail_connections_updated_at();

-- ============================================================================
-- FUNCTION: Get Gmail connection status
-- ============================================================================

CREATE OR REPLACE FUNCTION get_gmail_connection_status()
RETURNS TABLE (
  is_connected BOOLEAN,
  google_email TEXT,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  emails_synced_count INTEGER,
  auto_sync_enabled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    gc.is_active,
    gc.google_email,
    gc.last_sync_at,
    gc.last_sync_status,
    gc.emails_synced_count,
    gc.auto_sync_enabled
  FROM gmail_connections gc
  WHERE gc.user_id = auth.uid()
    AND gc.is_active = true
  LIMIT 1;
END;
$$;
