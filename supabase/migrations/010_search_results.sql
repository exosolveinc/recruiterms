-- ============================================================================
-- Search Results Table (for background batch analysis)
-- ============================================================================

-- Create table for storing job search analysis results
CREATE TABLE IF NOT EXISTS search_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resume_id UUID NOT NULL,
  external_job_id TEXT NOT NULL,
  job_title TEXT,
  company TEXT,
  match_score INTEGER,
  matching_skills JSONB DEFAULT '[]'::jsonb,
  missing_skills JSONB DEFAULT '[]'::jsonb,
  recommendations JSONB DEFAULT '[]'::jsonb,
  overall_assessment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One result per job per search session
  UNIQUE(session_id, external_job_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_search_results_session ON search_results(session_id);
CREATE INDEX IF NOT EXISTS idx_search_results_status ON search_results(status);
CREATE INDEX IF NOT EXISTS idx_search_results_user ON search_results(user_id);

-- Enable RLS
ALTER TABLE search_results ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own search results"
  ON search_results FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own search results"
  ON search_results FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own search results"
  ON search_results FOR UPDATE
  USING (user_id = auth.uid());

-- Service role can manage all results (for edge functions)
CREATE POLICY "Service role can manage all search results"
  ON search_results FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_search_results_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_search_results_timestamp ON search_results;
CREATE TRIGGER update_search_results_timestamp
  BEFORE UPDATE ON search_results
  FOR EACH ROW
  EXECUTE FUNCTION update_search_results_updated_at();

-- Enable Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE search_results;
