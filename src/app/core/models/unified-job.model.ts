/**
 * Unified Job Model
 * Combines jobs from API searches and email/vendor sources into a single interface
 */

export interface UnifiedJob {
  // Identifiers
  id: string;
  source_type: 'api' | 'email';
  source_platform: string; // 'adzuna', 'rapidapi', 'dice', 'linkedin', 'gmail', etc.

  // Core job data
  title: string;
  company: string;
  location: string;
  description: string;
  url?: string;

  // Dates
  posted_date: string;
  discovered_at: string; // When we first saw this job

  // Salary information
  salary_min?: number;
  salary_max?: number;
  salary_text?: string;
  pay_rate_type?: string; // 'hourly', 'annual', 'monthly', etc.

  // Work details
  employment_type?: string; // 'full_time', 'contract', 'w2', 'c2c', etc.
  work_arrangement?: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  duration?: string; // For contract jobs

  // Skills & requirements
  required_skills?: string[];
  tech_stack?: {
    frontend?: string[];
    backend?: string[];
    cloud?: string[];
    other?: string[];
  };
  years_experience?: string;
  certifications?: string[];

  // Analysis state
  match_score?: number;
  matching_skills?: string[];
  missing_skills?: string[];
  analyzed: boolean;
  analyzing: boolean;
  analysis_timestamp?: string;

  // Feed state
  is_new: boolean; // Not seen before
  is_seen: boolean; // User has scrolled past/clicked

  // Email-specific fields (for vendor jobs)
  vendor_job_id?: string;
  recruiter_name?: string;
  recruiter_email?: string;
  recruiter_phone?: string;
  recruiter_title?: string;
  vendor_company?: string;
  client_company?: string;
  email_subject?: string;
  email_received_at?: string;
  special_requirements?: string;
  status?: 'new' | 'reviewed' | 'interested' | 'not_interested' | 'applied' | 'expired' | 'archived';
}

export interface UnifiedFeedState {
  jobs: UnifiedJob[];
  lastRefreshTime: Date | null;
  isRefreshing: boolean;
  newJobsCount: number;
  seenJobIds: Set<string>;
  sourceFilter: 'all' | 'api' | 'email';
  sortBy: 'date' | 'match' | 'salary';
}

export interface AnalysisCacheEntry {
  jobId: string;
  resumeId: string;
  result: {
    match_score: number;
    matching_skills: string[];
    missing_skills: string[];
    recommendations?: string[];
  };
  timestamp: number;
  expiresAt: number; // 24 hours from creation
}

export interface RefreshConfig {
  intervalMinutes: number; // Default: 15
  enabled: boolean;
  maxJobsPerSource: number; // Default: 50
}
