-- ============================================================================
-- Migration: Candidate Preferences & Documents
-- Description: Add tables for storing candidate job preferences and documents
-- ============================================================================

-- ============================================================================
-- CANDIDATE PREFERENCES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS candidate_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Job preferences
    preferred_job_titles TEXT[] DEFAULT '{}',
    preferred_locations TEXT[] DEFAULT '{}',
    willing_to_relocate BOOLEAN DEFAULT FALSE,
    preferred_work_type TEXT[] DEFAULT '{}', -- 'remote', 'hybrid', 'onsite'
    preferred_company_size TEXT[] DEFAULT '{}', -- 'startup', 'small', 'medium', 'large', 'enterprise'
    preferred_industries TEXT[] DEFAULT '{}',

    -- Salary expectations
    salary_expectation_min INTEGER,
    salary_expectation_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',

    -- Availability
    available_start_date DATE,
    notice_period_days INTEGER,

    -- Work authorization
    visa_status TEXT,
    work_authorization TEXT,

    -- Additional info
    has_drivers_license BOOLEAN DEFAULT FALSE,
    willing_to_travel BOOLEAN DEFAULT FALSE,
    travel_percentage INTEGER,

    -- Notes
    notes TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Unique constraint per candidate per user
    UNIQUE(candidate_id, user_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_candidate_preferences_candidate_id ON candidate_preferences(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_preferences_user_id ON candidate_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_candidate_preferences_org_id ON candidate_preferences(organization_id);

-- ============================================================================
-- CANDIDATE DOCUMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS candidate_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Document info
    document_type TEXT NOT NULL CHECK (document_type IN (
        'drivers_license', 'passport', 'id_card', 'certification',
        'degree', 'reference', 'portfolio', 'other'
    )),
    document_name TEXT NOT NULL,

    -- File info
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT,
    file_size INTEGER,

    -- Metadata
    expiry_date DATE,
    notes TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_candidate_documents_candidate_id ON candidate_documents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_user_id ON candidate_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_org_id ON candidate_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_type ON candidate_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_expiry ON candidate_documents(expiry_date);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS
ALTER TABLE candidate_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_documents ENABLE ROW LEVEL SECURITY;

-- Candidate Preferences Policies
CREATE POLICY "Users can view own candidate preferences"
    ON candidate_preferences FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own candidate preferences"
    ON candidate_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own candidate preferences"
    ON candidate_preferences FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own candidate preferences"
    ON candidate_preferences FOR DELETE
    USING (auth.uid() = user_id);

-- Org members can view preferences in their org
CREATE POLICY "Org members can view org candidate preferences"
    ON candidate_preferences FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM profiles WHERE id = auth.uid()
        )
    );

-- Candidate Documents Policies
CREATE POLICY "Users can view own candidate documents"
    ON candidate_documents FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own candidate documents"
    ON candidate_documents FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own candidate documents"
    ON candidate_documents FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own candidate documents"
    ON candidate_documents FOR DELETE
    USING (auth.uid() = user_id);

-- Org members can view documents in their org
CREATE POLICY "Org members can view org candidate documents"
    ON candidate_documents FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM profiles WHERE id = auth.uid()
        )
    );

-- ============================================================================
-- STORAGE BUCKET FOR CANDIDATE DOCUMENTS
-- ============================================================================

-- Create storage bucket for candidate documents (run this in Supabase dashboard or via API)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'candidate-documents',
    'candidate-documents',
    FALSE,
    10485760, -- 10MB limit
    ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies for candidate-documents bucket
CREATE POLICY "Users can upload candidate documents"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'candidate-documents'
        AND auth.uid() IS NOT NULL
    );

CREATE POLICY "Users can view own candidate documents"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'candidate-documents'
        AND auth.uid() IS NOT NULL
    );

CREATE POLICY "Users can delete own candidate documents"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'candidate-documents'
        AND auth.uid() IS NOT NULL
    );

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

-- Create trigger function if not exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
DROP TRIGGER IF EXISTS update_candidate_preferences_updated_at ON candidate_preferences;
CREATE TRIGGER update_candidate_preferences_updated_at
    BEFORE UPDATE ON candidate_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_candidate_documents_updated_at ON candidate_documents;
CREATE TRIGGER update_candidate_documents_updated_at
    BEFORE UPDATE ON candidate_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to get candidates with expiring documents (within next 30 days)
CREATE OR REPLACE FUNCTION get_expiring_documents(days_ahead INTEGER DEFAULT 30)
RETURNS TABLE (
    document_id UUID,
    candidate_id TEXT,
    document_name TEXT,
    document_type TEXT,
    expiry_date DATE,
    days_until_expiry INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cd.id,
        cd.candidate_id,
        cd.document_name,
        cd.document_type,
        cd.expiry_date,
        (cd.expiry_date - CURRENT_DATE)::INTEGER as days_until_expiry
    FROM candidate_documents cd
    WHERE cd.user_id = auth.uid()
        AND cd.expiry_date IS NOT NULL
        AND cd.expiry_date <= CURRENT_DATE + days_ahead
        AND cd.expiry_date >= CURRENT_DATE
    ORDER BY cd.expiry_date ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get expired documents
CREATE OR REPLACE FUNCTION get_expired_documents()
RETURNS TABLE (
    document_id UUID,
    candidate_id TEXT,
    document_name TEXT,
    document_type TEXT,
    expiry_date DATE,
    days_expired INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cd.id,
        cd.candidate_id,
        cd.document_name,
        cd.document_type,
        cd.expiry_date,
        (CURRENT_DATE - cd.expiry_date)::INTEGER as days_expired
    FROM candidate_documents cd
    WHERE cd.user_id = auth.uid()
        AND cd.expiry_date IS NOT NULL
        AND cd.expiry_date < CURRENT_DATE
    ORDER BY cd.expiry_date DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
