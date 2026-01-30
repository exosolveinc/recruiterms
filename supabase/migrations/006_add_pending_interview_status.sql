-- ============================================================================
-- ADD PENDING STATUS TO INTERVIEW_STATUS ENUM
-- ============================================================================
-- This migration adds 'pending' as a new status for interviews.
-- Interviews start as 'pending' until approved by HR, then become 'scheduled'.
-- ============================================================================

-- Add 'pending' value to the interview_status enum
ALTER TYPE interview_status ADD VALUE IF NOT EXISTS 'pending' BEFORE 'scheduled';
