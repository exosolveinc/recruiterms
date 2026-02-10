-- ============================================================================
-- Add job_data column to search_results for full job persistence
-- ============================================================================

-- Store the full ExternalJob object so jobs can be reconstructed from DB
ALTER TABLE search_results ADD COLUMN IF NOT EXISTS job_data JSONB;

-- Index on resume_id for efficient lookups when loading a candidate's jobs
CREATE INDEX IF NOT EXISTS idx_search_results_resume ON search_results(resume_id);
