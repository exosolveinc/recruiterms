-- ============================================================================
-- Migration 015: Application Board AI Insights (daily cron-generated)
-- ============================================================================

-- Create table for storing AI-generated daily board insights
CREATE TABLE IF NOT EXISTS application_board_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  insight_date DATE NOT NULL DEFAULT CURRENT_DATE,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One insight per user per day
  UNIQUE(user_id, insight_date)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_board_insights_user ON application_board_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_board_insights_date ON application_board_insights(insight_date);

-- Enable RLS
ALTER TABLE application_board_insights ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own board insights"
  ON application_board_insights FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Service role can manage all board insights"
  ON application_board_insights FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_application_board_insights_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_application_board_insights_timestamp ON application_board_insights;
CREATE TRIGGER update_application_board_insights_timestamp
  BEFORE UPDATE ON application_board_insights
  FOR EACH ROW
  EXECUTE FUNCTION update_application_board_insights_updated_at();

-- ============================================================================
-- Job Feed AI Insights (daily cron-generated, per candidate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_feed_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  content TEXT NOT NULL,
  insight_date DATE NOT NULL DEFAULT CURRENT_DATE,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One insight per user per candidate per day
  UNIQUE(user_id, candidate_id, insight_date)
);

CREATE INDEX IF NOT EXISTS idx_feed_insights_user ON job_feed_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_insights_candidate ON job_feed_insights(candidate_id);

ALTER TABLE job_feed_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feed insights"
  ON job_feed_insights FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Service role can manage all feed insights"
  ON job_feed_insights FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE OR REPLACE FUNCTION update_job_feed_insights_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_job_feed_insights_timestamp ON job_feed_insights;
CREATE TRIGGER update_job_feed_insights_timestamp
  BEFORE UPDATE ON job_feed_insights
  FOR EACH ROW
  EXECUTE FUNCTION update_job_feed_insights_updated_at();

-- ============================================================================
-- pg_cron: Schedule daily insight generation at 6:00 AM UTC
-- ============================================================================

SELECT cron.unschedule('generate-board-insights-cron')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'generate-board-insights-cron'
);

SELECT cron.schedule(
  'generate-board-insights-cron',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://ibzozlezltgokzlfuksg.supabase.co/functions/v1/generate-board-insight',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{"all": true}'::jsonb
  );
  $$
);
