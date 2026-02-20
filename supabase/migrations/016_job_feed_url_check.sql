-- ============================================================================
-- Migration 016: Add url_checked_at column to job_feed
-- Tracks when each job URL was last health-checked so the cron can rotate
-- through jobs without re-checking recently validated ones.
-- ============================================================================

ALTER TABLE job_feed ADD COLUMN IF NOT EXISTS url_checked_at TIMESTAMPTZ;

-- Index to efficiently find jobs needing URL checks (never-checked first)
CREATE INDEX IF NOT EXISTS idx_job_feed_url_check
  ON job_feed (url_checked_at ASC NULLS FIRST)
  WHERE source_type = 'api' AND status != 'expired' AND url IS NOT NULL AND url != '';
