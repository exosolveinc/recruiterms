-- ============================================================================
-- SCHEDULED INTERVIEWS TABLE
-- ============================================================================
-- This migration creates the scheduled_interviews table for storing
-- interview appointments with Google Calendar integration support.
-- ============================================================================

-- Create interview type enum (if not exists)
DO $$ BEGIN
  CREATE TYPE interview_type AS ENUM (
    'phone',
    'video',
    'onsite',
    'technical',
    'behavioral',
    'panel',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create interview status enum (if not exists)
DO $$ BEGIN
  CREATE TYPE interview_status AS ENUM (
    'scheduled',
    'completed',
    'cancelled',
    'rescheduled',
    'no_show'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create scheduled_interviews table
CREATE TABLE IF NOT EXISTS scheduled_interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

  -- Interview details
  title TEXT NOT NULL,
  interview_type interview_type NOT NULL DEFAULT 'video',
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',

  -- Location/Meeting info
  location TEXT,
  meeting_link TEXT,

  -- Interviewer info
  interviewer_name TEXT,
  interviewer_email TEXT,

  -- Notes and additional info
  notes TEXT,

  -- Google Calendar integration
  google_event_id TEXT,
  google_event_link TEXT,

  -- Reminder tracking
  reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,

  -- Status and outcome
  status interview_status NOT NULL DEFAULT 'scheduled',
  outcome TEXT,
  feedback TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_scheduled_interviews_application_id ON scheduled_interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_interviews_user_id ON scheduled_interviews(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_interviews_organization_id ON scheduled_interviews(organization_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_interviews_scheduled_at ON scheduled_interviews(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_interviews_status ON scheduled_interviews(status);

-- Enable RLS
ALTER TABLE scheduled_interviews ENABLE ROW LEVEL SECURITY;

-- RLS Policies (drop and recreate to avoid conflicts)
DROP POLICY IF EXISTS "Users can view own interviews" ON scheduled_interviews;
CREATE POLICY "Users can view own interviews"
  ON scheduled_interviews
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own interviews" ON scheduled_interviews;
CREATE POLICY "Users can insert own interviews"
  ON scheduled_interviews
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own interviews" ON scheduled_interviews;
CREATE POLICY "Users can update own interviews"
  ON scheduled_interviews
  FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own interviews" ON scheduled_interviews;
CREATE POLICY "Users can delete own interviews"
  ON scheduled_interviews
  FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view org interviews" ON scheduled_interviews;
CREATE POLICY "Admins can view org interviews"
  ON scheduled_interviews
  FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_scheduled_interviews_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scheduled_interviews_updated_at ON scheduled_interviews;
CREATE TRIGGER scheduled_interviews_updated_at
  BEFORE UPDATE ON scheduled_interviews
  FOR EACH ROW
  EXECUTE FUNCTION update_scheduled_interviews_updated_at();

-- ============================================================================
-- VIEW: Interviews with application and job details
-- ============================================================================

CREATE OR REPLACE VIEW interview_details AS
SELECT
  si.id,
  si.application_id,
  si.user_id,
  si.organization_id,
  si.title,
  si.interview_type,
  si.scheduled_at,
  si.duration_minutes,
  si.timezone,
  si.location,
  si.meeting_link,
  si.interviewer_name,
  si.interviewer_email,
  si.notes,
  si.google_event_id,
  si.reminder_sent,
  si.status,
  si.outcome,
  si.feedback,
  si.created_at,
  si.updated_at,
  -- Job details
  j.job_title,
  j.company_name,
  j.location AS job_location,
  -- Application details
  ja.status AS application_status,
  ja.resume_id,
  -- Resume/Candidate details
  r.candidate_name
FROM scheduled_interviews si
JOIN job_applications ja ON si.application_id = ja.id
JOIN jobs j ON ja.job_id = j.id
LEFT JOIN resumes r ON ja.resume_id = r.id;

-- Grant access to the view
GRANT SELECT ON interview_details TO authenticated;

-- ============================================================================
-- FUNCTION: Get upcoming interviews
-- ============================================================================

CREATE OR REPLACE FUNCTION get_upcoming_interviews(days_ahead INTEGER DEFAULT 7)
RETURNS TABLE (
  id UUID,
  application_id UUID,
  title TEXT,
  interview_type interview_type,
  scheduled_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  timezone TEXT,
  location TEXT,
  meeting_link TEXT,
  interviewer_name TEXT,
  status interview_status,
  job_title TEXT,
  company_name TEXT,
  candidate_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.application_id,
    si.title,
    si.interview_type,
    si.scheduled_at,
    si.duration_minutes,
    si.timezone,
    si.location,
    si.meeting_link,
    si.interviewer_name,
    si.status,
    j.job_title,
    j.company_name,
    r.candidate_name
  FROM scheduled_interviews si
  JOIN job_applications ja ON si.application_id = ja.id
  JOIN jobs j ON ja.job_id = j.id
  LEFT JOIN resumes r ON ja.resume_id = r.id
  WHERE si.user_id = auth.uid()
    AND si.status = 'scheduled'
    AND si.scheduled_at >= NOW()
    AND si.scheduled_at <= NOW() + (days_ahead || ' days')::INTERVAL
  ORDER BY si.scheduled_at ASC;
END;
$$;
