-- ============================================================================
-- CANDIDATE GMAIL INTEGRATION
-- ============================================================================
-- This migration adds support for linking Gmail accounts to specific candidates
-- allowing multiple Gmail accounts per candidate (up to 3 per candidate)
-- ============================================================================

-- Step 1: Add candidate_id to gmail_connections
ALTER TABLE gmail_connections
ADD COLUMN IF NOT EXISTS candidate_id TEXT;

-- Step 2: Remove the unique constraint on user_id (allow multiple connections per user)
ALTER TABLE gmail_connections
DROP CONSTRAINT IF EXISTS gmail_connections_user_id_key;

-- Step 3: Remove old constraint if exists
ALTER TABLE gmail_connections
DROP CONSTRAINT IF EXISTS gmail_connections_user_candidate_unique;

-- Step 4: Add new unique constraint on (user_id, candidate_id, google_email)
-- This allows multiple Gmail accounts per candidate but prevents duplicate emails
ALTER TABLE gmail_connections
ADD CONSTRAINT gmail_connections_user_candidate_email_unique UNIQUE (user_id, candidate_id, google_email);

-- Step 5: Add index for candidate_id lookups
CREATE INDEX IF NOT EXISTS idx_gmail_connections_candidate_id
ON gmail_connections(candidate_id);

-- Step 6: Add candidate_id to vendor_job_emails for tracking which candidate's email sourced the job
ALTER TABLE vendor_job_emails
ADD COLUMN IF NOT EXISTS candidate_id TEXT;

-- Step 7: Add gmail_connection_id to vendor_job_emails to track which Gmail account sourced the job
ALTER TABLE vendor_job_emails
ADD COLUMN IF NOT EXISTS gmail_connection_id UUID REFERENCES gmail_connections(id);

CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_candidate_id
ON vendor_job_emails(candidate_id);

CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_gmail_connection_id
ON vendor_job_emails(gmail_connection_id);

-- Step 8: Add candidate_id to gmail_processed_emails
ALTER TABLE gmail_processed_emails
ADD COLUMN IF NOT EXISTS candidate_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gmail_processed_emails_candidate_id
ON gmail_processed_emails(candidate_id);

-- Step 9: Add candidate_id to gmail_sync_logs
ALTER TABLE gmail_sync_logs
ADD COLUMN IF NOT EXISTS candidate_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gmail_sync_logs_candidate_id
ON gmail_sync_logs(candidate_id);

-- ============================================================================
-- DROP existing functions/views to allow clean recreation
-- (handles signature changes and dependency ordering)
-- ============================================================================

DROP FUNCTION IF EXISTS get_candidate_vendor_jobs(text);
DROP FUNCTION IF EXISTS get_candidate_gmail_connections(text);
DROP FUNCTION IF EXISTS get_candidate_gmail_status(text);
DROP FUNCTION IF EXISTS can_add_gmail_for_candidate(text);
DROP FUNCTION IF EXISTS get_all_gmail_connections();
DROP FUNCTION IF EXISTS get_candidate_email_stats(text);
DROP FUNCTION IF EXISTS disconnect_gmail_connection(uuid);
DROP VIEW IF EXISTS vendor_job_email_details CASCADE;
DROP VIEW IF EXISTS gmail_connection_details CASCADE;

-- ============================================================================
-- VIEW: Vendor job emails with source Gmail account
-- (Must be created BEFORE get_candidate_vendor_jobs which depends on it)
-- ============================================================================

CREATE OR REPLACE VIEW vendor_job_email_details AS
SELECT
  vje.id,
  vje.user_id,
  vje.candidate_id,
  vje.gmail_connection_id,
  vje.email_subject,
  vje.email_from,
  vje.email_received_at,
  vje.job_title,
  vje.client_company,
  vje.location,
  vje.work_arrangement,
  vje.employment_type,
  vje.duration,
  vje.pay_rate,
  vje.pay_rate_min,
  vje.pay_rate_max,
  vje.required_skills,
  vje.years_experience,
  vje.special_requirements,
  vje.tech_stack,
  vje.job_description,
  vje.recruiter_name,
  vje.recruiter_email,
  vje.recruiter_phone,
  vje.recruiter_title,
  vje.is_interested,
  vje.is_applied,
  vje.status,
  vje.notes,
  vje.created_at,
  vje.updated_at,
  -- Vendor info
  v.company_name AS vendor_company,
  v.website AS vendor_website,
  v.rating AS vendor_rating,
  v.is_blocked AS vendor_blocked,
  -- Contact info
  vc.name AS contact_name,
  vc.email AS contact_email,
  vc.phone AS contact_phone,
  -- Source Gmail account
  gc.google_email AS source_gmail
FROM vendor_job_emails vje
LEFT JOIN vendors v ON vje.vendor_id = v.id
LEFT JOIN vendor_contacts vc ON vje.vendor_contact_id = vc.id
LEFT JOIN gmail_connections gc ON vje.gmail_connection_id = gc.id;

GRANT SELECT ON vendor_job_email_details TO authenticated;

-- ============================================================================
-- VIEW: Gmail connections with candidate info
-- ============================================================================

CREATE OR REPLACE VIEW gmail_connection_details AS
SELECT
  gc.id,
  gc.user_id,
  gc.candidate_id,
  gc.google_email,
  gc.is_active,
  gc.auto_sync_enabled,
  gc.sync_frequency_minutes,
  gc.search_keywords,
  gc.exclude_senders,
  gc.last_sync_at,
  gc.last_sync_status,
  gc.last_sync_error,
  gc.emails_synced_count,
  gc.created_at,
  gc.updated_at,
  -- Count of jobs from this specific connection
  (SELECT COUNT(*) FROM vendor_job_emails vje WHERE vje.gmail_connection_id = gc.id) as jobs_count
FROM gmail_connections gc
WHERE gc.is_active = true;

-- ============================================================================
-- FUNCTION: Get all Gmail connections for a specific candidate (up to 3)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_candidate_gmail_connections(p_candidate_id TEXT)
RETURNS TABLE (
  connection_id UUID,
  google_email TEXT,
  is_active BOOLEAN,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  emails_synced_count INTEGER,
  auto_sync_enabled BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    gc.id,
    gc.google_email,
    gc.is_active,
    gc.last_sync_at,
    gc.last_sync_status,
    gc.emails_synced_count,
    gc.auto_sync_enabled,
    gc.created_at
  FROM gmail_connections gc
  WHERE gc.user_id = auth.uid()
    AND gc.candidate_id = p_candidate_id
    AND gc.is_active = true
  ORDER BY gc.created_at ASC
  LIMIT 3;
END;
$$;

-- ============================================================================
-- FUNCTION: Get Gmail connection status for a specific candidate (returns first/primary)
-- For backward compatibility
-- ============================================================================

CREATE OR REPLACE FUNCTION get_candidate_gmail_status(p_candidate_id TEXT)
RETURNS TABLE (
  is_connected BOOLEAN,
  google_email TEXT,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  emails_synced_count INTEGER,
  auto_sync_enabled BOOLEAN,
  connection_id UUID,
  connections_count INTEGER
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
    gc.auto_sync_enabled,
    gc.id,
    (SELECT COUNT(*)::INTEGER FROM gmail_connections gc2
     WHERE gc2.user_id = auth.uid() AND gc2.candidate_id = p_candidate_id AND gc2.is_active = true) as connections_count
  FROM gmail_connections gc
  WHERE gc.user_id = auth.uid()
    AND gc.candidate_id = p_candidate_id
    AND gc.is_active = true
  ORDER BY gc.created_at ASC
  LIMIT 1;
END;
$$;

-- ============================================================================
-- FUNCTION: Check if candidate can add more Gmail accounts
-- ============================================================================

CREATE OR REPLACE FUNCTION can_add_gmail_for_candidate(p_candidate_id TEXT)
RETURNS TABLE (
  can_add BOOLEAN,
  current_count INTEGER,
  max_allowed INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
  v_max INTEGER := 3;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count
  FROM gmail_connections gc
  WHERE gc.user_id = auth.uid()
    AND gc.candidate_id = p_candidate_id
    AND gc.is_active = true;

  RETURN QUERY SELECT (v_count < v_max), v_count, v_max;
END;
$$;

-- ============================================================================
-- FUNCTION: Get all Gmail connections for current user
-- ============================================================================

CREATE OR REPLACE FUNCTION get_all_gmail_connections()
RETURNS TABLE (
  id UUID,
  candidate_id TEXT,
  google_email TEXT,
  is_active BOOLEAN,
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
    gc.id,
    gc.candidate_id,
    gc.google_email,
    gc.is_active,
    gc.last_sync_at,
    gc.last_sync_status,
    gc.emails_synced_count,
    gc.auto_sync_enabled
  FROM gmail_connections gc
  WHERE gc.user_id = auth.uid()
    AND gc.is_active = true
  ORDER BY gc.candidate_id, gc.created_at ASC;
END;
$$;

-- ============================================================================
-- FUNCTION: Get vendor jobs for a specific candidate
-- (Depends on vendor_job_email_details view created above)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_candidate_vendor_jobs(p_candidate_id TEXT)
RETURNS SETOF vendor_job_email_details
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM vendor_job_email_details
  WHERE user_id = auth.uid()
    AND candidate_id = p_candidate_id
  ORDER BY email_received_at DESC NULLS LAST, created_at DESC;
END;
$$;

-- ============================================================================
-- FUNCTION: Get email statistics for a candidate (aggregated across all Gmail accounts)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_candidate_email_stats(p_candidate_id TEXT)
RETURNS TABLE (
  total_emails INTEGER,
  job_emails INTEGER,
  new_jobs INTEGER,
  interested_jobs INTEGER,
  applied_jobs INTEGER,
  last_sync_at TIMESTAMPTZ,
  gmail_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE((SELECT COUNT(*)::INTEGER FROM gmail_processed_emails gpe
              WHERE gpe.user_id = auth.uid() AND gpe.candidate_id = p_candidate_id), 0) as total_emails,
    COALESCE((SELECT COUNT(*)::INTEGER FROM gmail_processed_emails gpe
              WHERE gpe.user_id = auth.uid() AND gpe.candidate_id = p_candidate_id AND gpe.was_job_email = true), 0) as job_emails,
    COALESCE((SELECT COUNT(*)::INTEGER FROM vendor_job_emails vje
              WHERE vje.user_id = auth.uid() AND vje.candidate_id = p_candidate_id AND vje.status = 'new'), 0) as new_jobs,
    COALESCE((SELECT COUNT(*)::INTEGER FROM vendor_job_emails vje
              WHERE vje.user_id = auth.uid() AND vje.candidate_id = p_candidate_id AND vje.status = 'interested'), 0) as interested_jobs,
    COALESCE((SELECT COUNT(*)::INTEGER FROM vendor_job_emails vje
              WHERE vje.user_id = auth.uid() AND vje.candidate_id = p_candidate_id AND vje.is_applied = true), 0) as applied_jobs,
    (SELECT MAX(gc.last_sync_at) FROM gmail_connections gc
     WHERE gc.user_id = auth.uid() AND gc.candidate_id = p_candidate_id AND gc.is_active = true) as last_sync_at,
    (SELECT COUNT(*)::INTEGER FROM gmail_connections gc
     WHERE gc.user_id = auth.uid() AND gc.candidate_id = p_candidate_id AND gc.is_active = true) as gmail_count;
END;
$$;

-- ============================================================================
-- FUNCTION: Disconnect a specific Gmail account by connection ID
-- ============================================================================

CREATE OR REPLACE FUNCTION disconnect_gmail_connection(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_affected INTEGER;
BEGIN
  UPDATE gmail_connections
  SET
    is_active = false,
    access_token = NULL,
    refresh_token = NULL,
    updated_at = NOW()
  WHERE id = p_connection_id
    AND user_id = auth.uid();

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected > 0;
END;
$$;
