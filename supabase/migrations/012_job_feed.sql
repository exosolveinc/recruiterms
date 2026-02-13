-- ============================================================================
-- Migration 012: Job Feed Table
-- Stores all jobs (API + email) per candidate with inline analysis results
-- ============================================================================

-- Step 1: Create the job_feed table
CREATE TABLE IF NOT EXISTS job_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID,
  dedup_key TEXT NOT NULL,  -- lower(title)|lower(company)|lower(location)|salaryRange

  -- Source
  source_type TEXT NOT NULL DEFAULT 'api',
  source_platform TEXT NOT NULL,
  external_id TEXT,

  -- Job data
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT DEFAULT '',
  description TEXT DEFAULT '',
  url TEXT,
  posted_date TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),

  -- Salary
  salary_min NUMERIC,
  salary_max NUMERIC,
  salary_text TEXT,
  pay_rate_type TEXT,

  -- Work details
  employment_type TEXT,
  work_arrangement TEXT,
  duration TEXT,

  -- Skills
  required_skills JSONB DEFAULT '[]',
  tech_stack JSONB,
  years_experience TEXT,
  certifications JSONB DEFAULT '[]',

  -- Analysis (inline)
  resume_id UUID,
  match_score INTEGER,
  matching_skills JSONB DEFAULT '[]',
  missing_skills JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]',
  overall_assessment TEXT,
  analysis_status TEXT DEFAULT 'pending',
  analysis_error TEXT,
  analyzed_at TIMESTAMPTZ,

  -- Feed state
  is_seen BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'new',

  -- Email-specific fields
  vendor_job_id TEXT,
  recruiter_name TEXT,
  recruiter_email TEXT,
  recruiter_phone TEXT,
  vendor_company TEXT,
  client_company TEXT,
  email_subject TEXT,
  email_received_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(candidate_id, dedup_key)
);

-- Step 2: Indexes
CREATE INDEX IF NOT EXISTS idx_job_feed_candidate_id ON job_feed(candidate_id);
CREATE INDEX IF NOT EXISTS idx_job_feed_user_id ON job_feed(user_id);
CREATE INDEX IF NOT EXISTS idx_job_feed_analysis_status ON job_feed(analysis_status);
CREATE INDEX IF NOT EXISTS idx_job_feed_candidate_created ON job_feed(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_feed_candidate_match ON job_feed(candidate_id, match_score DESC NULLS LAST);

-- Step 3: Updated_at trigger
CREATE OR REPLACE FUNCTION update_job_feed_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_feed_updated_at ON job_feed;
CREATE TRIGGER job_feed_updated_at
  BEFORE UPDATE ON job_feed
  FOR EACH ROW
  EXECUTE FUNCTION update_job_feed_updated_at();

-- Step 4: Row Level Security
ALTER TABLE job_feed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own job feed" ON job_feed;
CREATE POLICY "Users can view own job feed"
  ON job_feed FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own job feed" ON job_feed;
CREATE POLICY "Users can insert own job feed"
  ON job_feed FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own job feed" ON job_feed;
CREATE POLICY "Users can update own job feed"
  ON job_feed FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own job feed" ON job_feed;
CREATE POLICY "Users can delete own job feed"
  ON job_feed FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass (for edge functions / cron)
DROP POLICY IF EXISTS "Service role full access to job feed" ON job_feed;
CREATE POLICY "Service role full access to job feed"
  ON job_feed FOR ALL
  USING (auth.role() = 'service_role');

-- Step 5: Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE job_feed;

-- Step 6: Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON job_feed TO authenticated;
GRANT ALL ON job_feed TO service_role;
