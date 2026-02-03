-- ============================================================================
-- Interview AI Insights Table
-- ============================================================================

-- Create table for storing AI-generated interview preparation insights
CREATE TABLE IF NOT EXISTS interview_ai_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES scheduled_interviews(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ensure one insight per interview
  UNIQUE(interview_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_ai_insights_interview ON interview_ai_insights(interview_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_application ON interview_ai_insights(application_id);

-- Enable RLS
ALTER TABLE interview_ai_insights ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view insights for their own interviews
CREATE POLICY "Users can view own interview insights"
  ON interview_ai_insights FOR SELECT
  USING (
    interview_id IN (
      SELECT id FROM scheduled_interviews WHERE user_id = auth.uid()
    )
  );

-- Users can insert insights for their own interviews
CREATE POLICY "Users can create own interview insights"
  ON interview_ai_insights FOR INSERT
  WITH CHECK (
    interview_id IN (
      SELECT id FROM scheduled_interviews WHERE user_id = auth.uid()
    )
  );

-- Users can update insights for their own interviews
CREATE POLICY "Users can update own interview insights"
  ON interview_ai_insights FOR UPDATE
  USING (
    interview_id IN (
      SELECT id FROM scheduled_interviews WHERE user_id = auth.uid()
    )
  );

-- Service role can manage all insights
CREATE POLICY "Service role can manage all insights"
  ON interview_ai_insights FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_interview_ai_insights_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_interview_ai_insights_timestamp ON interview_ai_insights;
CREATE TRIGGER update_interview_ai_insights_timestamp
  BEFORE UPDATE ON interview_ai_insights
  FOR EACH ROW
  EXECUTE FUNCTION update_interview_ai_insights_updated_at();
