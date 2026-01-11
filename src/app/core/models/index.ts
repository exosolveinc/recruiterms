// ============================================================================
// DATABASE MODELS - Matching Supabase Schema v4
// ============================================================================

// Enums
export type UserRole = 'user' | 'admin';
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type JobStatus = 'new' | 'reviewing' | 'applied' | 'interviewing' | 'offered' | 'rejected' | 'archived';
export type ApplicationStatus = 'extracted' | 'applied' | 'screening' | 'interviewing' | 'offer' | 'accepted' | 'rejected' | 'withdrawn';

// Organization
export interface Organization {
  id: string;
  name: string;
  created_at: string;
}

// Profile
export interface Profile {
  id: string;
  organization_id: string | null;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  is_active: boolean;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

// Skill
export interface Skill {
  name: string;
  proficiency?: 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  years?: number;
}

// Education
export interface Education {
  degree: string;
  institution: string;
  year?: number;
  field?: string;
}

// Certification
export interface Certification {
  name: string;
  issuer?: string;
  year?: number;
}

// Work History
export interface WorkHistory {
  title: string;
  company: string;
  start: string;
  end?: string;
  description?: string;
  achievements?: string[];
}

// Resume
export interface Resume {
  id: string;
  user_id: string;
  organization_id: string | null;
  file_name: string;
  file_url: string;
  file_type: string | null;
  candidate_name: string | null;
  candidate_email: string | null;
  candidate_phone: string | null;
  candidate_location: string | null;
  candidate_linkedin: string | null;
  current_title: string | null;
  current_company: string | null;
  years_of_experience: number | null;
  experience_level: string | null;
  skills: Skill[];
  education: Education[];
  certifications: Certification[];
  work_history: WorkHistory[];
  professional_summary: string | null;
  preferred_work_type: string[] | null;
  salary_expectation_min: number | null;
  salary_expectation_max: number | null;
  extraction_status: ExtractionStatus;
  extraction_confidence: number | null;
  is_primary: boolean;
  label: string | null;
  created_at: string;
  updated_at: string;
}

// Required Skill (for Jobs)
export interface RequiredSkill {
  skill: string;
  importance: 'Required' | 'Preferred';
  years?: number;
}

// Benefit
export interface Benefit {
  category: string;
  items: string[];
}

// Match Analysis
export interface MatchAnalysis {
  skills_match?: {
    score: number;
    matching: string[];
    missing: string[];
  };
  experience_match?: {
    score: number;
    details: string;
  };
  education_match?: {
    score: number;
    details: string;
  };
}

// Job
export interface Job {
  id: string;
  user_id: string;
  organization_id: string | null;
  resume_id: string | null;
  source_url: string;
  platform: string | null;
  job_title: string | null;
  company_name: string | null;
  company_website: string | null;
  company_size: string | null;
  company_industry: string | null;
  location: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  is_remote: boolean | null;
  work_type: string | null;
  employment_type: string | null;
  experience_level: string | null;
  years_experience_required: string | null;
  salary_raw: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: string | null;
  has_bonus: boolean | null;
  has_equity: boolean | null;
  required_skills: RequiredSkill[];
  required_education: string | null;
  required_certifications: string[] | null;
  benefits: Benefit[];
  description_summary: string | null;
  description_full: string | null;
  responsibilities: string[] | null;
  qualifications: string[] | null;
  posted_date: string | null;
  application_deadline: string | null;
  application_url: string | null;
  easy_apply: boolean | null;
  visa_sponsorship: boolean | null;
  match_score: number | null;
  match_analysis: MatchAnalysis;
  missing_skills: string[] | null;
  matching_skills: string[] | null;
  recommendations: string[] | null;
  extraction_status: ExtractionStatus;
  extraction_confidence: number | null;
  status: JobStatus;
  priority: number;
  notes: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

// Interview
export interface Interview {
  type: string;
  scheduled_at?: string;
  duration_minutes?: number;
  location?: string;
  interviewer?: string;
  notes?: string;
  outcome?: string;
}

// Job Application
export interface JobApplication {
  id: string;
  user_id: string;
  organization_id: string | null;
  job_id: string;
  resume_id: string | null;
  applied_at: string;
  application_method: string | null;
  status: ApplicationStatus;
  status_updated_at: string;
  interviews: Interview[];
  next_step: string | null;
  next_step_date: string | null;
  offered_salary: number | null;
  offer_details: any | null;
  outcome: string | null;
  outcome_date: string | null;
  outcome_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Activity Log
export interface ActivityLog {
  id: string;
  user_id: string;
  organization_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, any>;
  created_at: string;
}

// ============================================================================
// DASHBOARD VIEW MODELS
// ============================================================================

export interface UserDashboard {
  user_id: string;
  organization_id: string | null;
  total_resumes: number;
  total_jobs: number;
  total_applications: number;
  jobs_new: number;
  jobs_applied: number;
  jobs_interviewing: number;
  jobs_offered: number;
  apps_pending: number;
  apps_interviewing: number;
  apps_offers: number;
  apps_accepted: number;
  apps_rejected: number;
  avg_match_score: number | null;
  activity_7d: number;
}

export interface AdminOrgDashboard {
  organization_id: string;
  organization_name: string;
  total_members: number;
  active_members_7d: number;
  total_resumes: number;
  total_jobs: number;
  total_applications: number;
  successful_placements: number;
  resumes_7d: number;
  jobs_7d: number;
  applications_7d: number;
}

export interface AdminEmployeeStats {
  user_id: string;
  organization_id: string;
  full_name: string | null;
  email: string;
  role: UserRole;
  is_active: boolean;
  last_active_at: string | null;
  joined_at: string;
  total_resumes: number;
  total_jobs: number;
  total_applications: number;
  placements: number;
  jobs_7d: number;
  applications_7d: number;
  avg_match_score: number | null;
}

// Candidate Preferences
export interface CandidatePreferences {
  preferred_job_titles: string[];
  preferred_locations: string[];
  willing_to_relocate: boolean;
  preferred_work_type: ('remote' | 'hybrid' | 'onsite')[];
  preferred_company_size: ('startup' | 'small' | 'medium' | 'large' | 'enterprise')[];
  preferred_industries: string[];
  salary_expectation_min: number | null;
  salary_expectation_max: number | null;
  salary_currency: string;
  available_start_date: string | null;
  notice_period_days: number | null;
  visa_status: string | null;
  work_authorization: string | null;
  has_drivers_license: boolean;
  willing_to_travel: boolean;
  travel_percentage: number | null;
  notes: string | null;
}

// Candidate Document
export interface CandidateDocument {
  id: string;
  candidate_id: string;
  user_id: string;
  organization_id: string | null;
  document_type: 'drivers_license' | 'passport' | 'id_card' | 'certification' | 'degree' | 'reference' | 'portfolio' | 'other';
  document_name: string;
  file_name: string;
  file_url: string;
  file_type: string | null;
  file_size: number | null;
  expiry_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Gmail Connection Status for a Candidate
export interface CandidateGmailConnection {
  id: string;
  candidate_id: string;
  google_email: string;
  is_active: boolean;
  auto_sync_enabled: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  emails_synced_count: number;
  jobs_count?: number;
  created_at?: string;
}

// Email statistics for a candidate
export interface CandidateEmailStats {
  total_emails: number;
  job_emails: number;
  new_jobs: number;
  interested_jobs: number;
  applied_jobs: number;
  last_sync_at: string | null;
  gmail_count?: number; // Number of Gmail accounts connected
}

// Candidate (aggregated from resumes)
export interface Candidate {
  id: string; // Generated unique ID for the candidate
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  current_title: string | null;
  current_company: string | null;
  years_of_experience: number | null;
  experience_level: string | null;
  skills: Skill[];
  resumes: Resume[]; // All resumes associated with this candidate
  resume_count: number;
  last_updated: string;
  created_at: string;
  // New fields for preferences and documents
  preferences: CandidatePreferences | null;
  documents: CandidateDocument[];
  // Gmail integration (supports up to 3 accounts per candidate)
  gmail_connections?: CandidateGmailConnection[];
  email_stats?: CandidateEmailStats | null;
}

export interface UserApplicationView {
  id: string;
  user_id: string;
  job_id: string;
  resume_id: string | null;
  job_title: string | null;
  company_name: string | null;
  platform: string | null;
  work_type: string | null;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  match_score: number | null;
  experience_level: string | null;
  required_skills: RequiredSkill[] | null;
  matching_skills: string[] | null;
  missing_skills: string[] | null;
  source_url: string | null;
  status: ApplicationStatus;
  applied_at: string;
  next_step: string | null;
  next_step_date: string | null;
  interviews: Interview[];
  offered_salary: number | null;
  outcome: string | null;
  notes: string | null;
}

// Re-export unified job models
export * from './unified-job.model';