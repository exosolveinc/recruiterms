-- ============================================================================
-- SET PENDING AS DEFAULT INTERVIEW STATUS
-- ============================================================================
-- This must run AFTER the pending enum value has been committed.
-- ============================================================================

-- Update the default status for new interviews to 'pending'
ALTER TABLE scheduled_interviews ALTER COLUMN status SET DEFAULT 'pending';
