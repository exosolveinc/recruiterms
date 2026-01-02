-- ============================================================================
-- VENDOR JOB EMAILS TABLE
-- ============================================================================
-- This migration creates tables for storing job listings extracted from
-- vendor/recruiter emails with all relevant details.
-- ============================================================================

-- Create employment type enum (if not exists)
DO $$ BEGIN
  CREATE TYPE employment_type AS ENUM (
    'w2',
    'c2c',
    '1099',
    'full_time',
    'contract',
    'contract_to_hire',
    'part_time',
    'unknown'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create work arrangement enum (if not exists)
DO $$ BEGIN
  CREATE TYPE work_arrangement AS ENUM (
    'onsite',
    'remote',
    'hybrid',
    'unknown'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- VENDORS TABLE - Store vendor/staffing company information
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Vendor company info
  company_name TEXT NOT NULL,
  website TEXT,

  -- Contact tracking
  emails_received INTEGER DEFAULT 0,
  jobs_posted INTEGER DEFAULT 0,

  -- Rating/Notes
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  notes TEXT,
  is_blocked BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint per user
  UNIQUE(user_id, company_name)
);

-- ============================================================================
-- VENDOR CONTACTS TABLE - Store individual recruiter contacts
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Contact info
  name TEXT NOT NULL,
  title TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  linkedin_url TEXT,

  -- Tracking
  emails_sent INTEGER DEFAULT 0,
  last_contact_at TIMESTAMPTZ,

  -- Notes
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint
  UNIQUE(vendor_id, email)
);

-- ============================================================================
-- VENDOR JOB EMAILS TABLE - Store extracted job listings from emails
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_job_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_contact_id UUID REFERENCES vendor_contacts(id) ON DELETE SET NULL,

  -- Email metadata
  email_id TEXT, -- Original email ID from email provider
  email_subject TEXT,
  email_from TEXT NOT NULL,
  email_received_at TIMESTAMPTZ,
  email_body_raw TEXT, -- Original email body for reference

  -- Job details (extracted)
  job_title TEXT NOT NULL,
  client_company TEXT, -- The actual client (e.g., Capital One)
  location TEXT,
  work_arrangement work_arrangement DEFAULT 'unknown',
  employment_type employment_type DEFAULT 'unknown',
  duration TEXT, -- e.g., "Long term", "6 months", "12 months"

  -- Compensation
  pay_rate TEXT, -- Raw pay rate string
  pay_rate_min DECIMAL(10,2),
  pay_rate_max DECIMAL(10,2),
  pay_rate_type TEXT, -- 'hourly', 'annual', etc.

  -- Requirements
  required_skills TEXT[], -- Array of skills
  years_experience TEXT,
  certifications TEXT[],
  special_requirements TEXT, -- e.g., "Ex-Capital One Only"

  -- Tech stack
  tech_stack JSONB, -- Structured tech stack info

  -- Job description
  job_description TEXT,

  -- Recruiter contact from email
  recruiter_name TEXT,
  recruiter_email TEXT,
  recruiter_phone TEXT,
  recruiter_title TEXT,

  -- Tracking
  is_interested BOOLEAN,
  is_applied BOOLEAN DEFAULT FALSE,
  applied_at TIMESTAMPTZ,
  application_id UUID REFERENCES job_applications(id) ON DELETE SET NULL,

  -- Status
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'interested', 'not_interested', 'applied', 'expired', 'archived')),
  notes TEXT,

  -- AI extraction metadata
  extraction_confidence DECIMAL(3,2), -- 0.00 to 1.00
  extraction_errors TEXT[],

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Vendors indexes
CREATE INDEX IF NOT EXISTS idx_vendors_user_id ON vendors(user_id);
CREATE INDEX IF NOT EXISTS idx_vendors_company_name ON vendors(company_name);

-- Vendor contacts indexes
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_vendor_id ON vendor_contacts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_user_id ON vendor_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_email ON vendor_contacts(email);

-- Vendor job emails indexes
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_user_id ON vendor_job_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_vendor_id ON vendor_job_emails(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_status ON vendor_job_emails(status);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_job_title ON vendor_job_emails(job_title);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_client_company ON vendor_job_emails(client_company);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_created_at ON vendor_job_emails(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_email_received_at ON vendor_job_emails(email_received_at DESC);

-- Full text search index on job title and description
CREATE INDEX IF NOT EXISTS idx_vendor_job_emails_fts ON vendor_job_emails
  USING gin(to_tsvector('english', coalesce(job_title, '') || ' ' || coalesce(job_description, '')));

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_job_emails ENABLE ROW LEVEL SECURITY;

-- Vendors policies
DROP POLICY IF EXISTS "Users can view own vendors" ON vendors;
CREATE POLICY "Users can view own vendors"
  ON vendors FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own vendors" ON vendors;
CREATE POLICY "Users can insert own vendors"
  ON vendors FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own vendors" ON vendors;
CREATE POLICY "Users can update own vendors"
  ON vendors FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own vendors" ON vendors;
CREATE POLICY "Users can delete own vendors"
  ON vendors FOR DELETE
  USING (auth.uid() = user_id);

-- Vendor contacts policies
DROP POLICY IF EXISTS "Users can view own vendor contacts" ON vendor_contacts;
CREATE POLICY "Users can view own vendor contacts"
  ON vendor_contacts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own vendor contacts" ON vendor_contacts;
CREATE POLICY "Users can insert own vendor contacts"
  ON vendor_contacts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own vendor contacts" ON vendor_contacts;
CREATE POLICY "Users can update own vendor contacts"
  ON vendor_contacts FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own vendor contacts" ON vendor_contacts;
CREATE POLICY "Users can delete own vendor contacts"
  ON vendor_contacts FOR DELETE
  USING (auth.uid() = user_id);

-- Vendor job emails policies
DROP POLICY IF EXISTS "Users can view own vendor job emails" ON vendor_job_emails;
CREATE POLICY "Users can view own vendor job emails"
  ON vendor_job_emails FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own vendor job emails" ON vendor_job_emails;
CREATE POLICY "Users can insert own vendor job emails"
  ON vendor_job_emails FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own vendor job emails" ON vendor_job_emails;
CREATE POLICY "Users can update own vendor job emails"
  ON vendor_job_emails FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own vendor job emails" ON vendor_job_emails;
CREATE POLICY "Users can delete own vendor job emails"
  ON vendor_job_emails FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update timestamps trigger for vendors
CREATE OR REPLACE FUNCTION update_vendors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_updated_at ON vendors;
CREATE TRIGGER vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW
  EXECUTE FUNCTION update_vendors_updated_at();

-- Update timestamps trigger for vendor_contacts
CREATE OR REPLACE FUNCTION update_vendor_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_contacts_updated_at ON vendor_contacts;
CREATE TRIGGER vendor_contacts_updated_at
  BEFORE UPDATE ON vendor_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_contacts_updated_at();

-- Update timestamps trigger for vendor_job_emails
CREATE OR REPLACE FUNCTION update_vendor_job_emails_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_job_emails_updated_at ON vendor_job_emails;
CREATE TRIGGER vendor_job_emails_updated_at
  BEFORE UPDATE ON vendor_job_emails
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_job_emails_updated_at();

-- ============================================================================
-- VIEW: Vendor job emails with vendor details
-- ============================================================================

CREATE OR REPLACE VIEW vendor_job_email_details AS
SELECT
  vje.id,
  vje.user_id,
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
  vc.phone AS contact_phone
FROM vendor_job_emails vje
LEFT JOIN vendors v ON vje.vendor_id = v.id
LEFT JOIN vendor_contacts vc ON vje.vendor_contact_id = vc.id;

GRANT SELECT ON vendor_job_email_details TO authenticated;

-- ============================================================================
-- FUNCTION: Get vendor job stats
-- ============================================================================

CREATE OR REPLACE FUNCTION get_vendor_job_stats()
RETURNS TABLE (
  total_jobs BIGINT,
  new_jobs BIGINT,
  interested_jobs BIGINT,
  applied_jobs BIGINT,
  total_vendors BIGINT,
  jobs_this_week BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_jobs,
    COUNT(*) FILTER (WHERE status = 'new')::BIGINT AS new_jobs,
    COUNT(*) FILTER (WHERE status = 'interested' OR is_interested = true)::BIGINT AS interested_jobs,
    COUNT(*) FILTER (WHERE is_applied = true)::BIGINT AS applied_jobs,
    (SELECT COUNT(DISTINCT vendor_id) FROM vendor_job_emails WHERE user_id = auth.uid())::BIGINT AS total_vendors,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::BIGINT AS jobs_this_week
  FROM vendor_job_emails
  WHERE user_id = auth.uid();
END;
$$;
