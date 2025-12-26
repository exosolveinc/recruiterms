import { Injectable } from '@angular/core';
import { createClient, Session, SupabaseClient, User } from '@supabase/supabase-js';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  AdminEmployeeStats,
  AdminOrgDashboard,
  Candidate,
  CandidateDocument,
  CandidatePreferences,
  Job,
  JobApplication,
  Organization,
  Profile,
  Resume,
  Skill,
  UserApplicationView,
  UserDashboard,
  UserRole
} from '../models';

@Injectable({
  providedIn: 'root'
})
export class SupabaseService {
  private supabase: SupabaseClient;
  private _session = new BehaviorSubject<Session | null>(null);
  private _user = new BehaviorSubject<User | null>(null);
  private _profile = new BehaviorSubject<Profile | null>(null);

  session$ = this._session.asObservable();
  user$ = this._user.asObservable();
  profile$ = this._profile.asObservable();

  constructor() {
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    // Listen for auth changes
    this.supabase.auth.onAuthStateChange((event, session) => {
      this._session.next(session);
      this._user.next(session?.user ?? null);

      if (session?.user) {
        this.loadProfile(session.user.id);
      } else {
        this._profile.next(null);
      }
    });

    // Check initial session
    this.supabase.auth.getSession().then(({ data: { session } }) => {
      this._session.next(session);
      this._user.next(session?.user ?? null);
      if (session?.user) {
        this.loadProfile(session.user.id);
      }
    });
  }

  // ============================================================================
  // AUTH
  // ============================================================================

  async signUp(email: string, password: string, fullName: string) {
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName }
      }
    });
    if (error) throw error;
    return data;
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) throw error;
    return data;
  }

  async signOut() {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw error;
  }

  async resetPassword(email: string) {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  }

  // ============================================================================
  // PROFILE
  // ============================================================================

  private async loadProfile(userId: string) {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (!error && data) {
      this._profile.next(data as Profile);
    }
  }

  async getProfile(): Promise<Profile | null> {
    const user = this._user.value;
    if (!user) return null;

    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error) throw error;
    return data as Profile;
  }

  async updateProfile(updates: Partial<Profile>): Promise<Profile> {
    const user = this._user.value;
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();

    if (error) throw error;
    this._profile.next(data as Profile);
    return data as Profile;
  }

  // ============================================================================
  // ORGANIZATIONS
  // ============================================================================

  async createOrganization(name: string): Promise<string> {
    const { data, error } = await this.supabase.rpc('create_organization', {
      org_name: name
    });
    if (error) throw error;
    await this.loadProfile(this._user.value!.id);
    return data as string;
  }

  async addUserToOrg(userId: string, orgId: string, role: UserRole = 'user'): Promise<boolean> {
    const { data, error } = await this.supabase.rpc('add_user_to_org', {
      p_user_id: userId,
      p_org_id: orgId,
      p_role: role
    });
    if (error) throw error;
    return data as boolean;
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    const { data, error } = await this.supabase
      .from('organizations')
      .select('*')
      .eq('id', orgId)
      .single();

    if (error) throw error;
    return data as Organization;
  }

  // ============================================================================
  // RESUMES
  // ============================================================================

  async uploadResumeFile(file: File): Promise<{ path: string; url: string }> {
    const user = this._user.value;
    if (!user) throw new Error('Not authenticated');

    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}.${fileExt}`;
    const filePath = `${user.id}/${fileName}`;

    const { error: uploadError } = await this.supabase.storage
      .from('resumes')
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = this.supabase.storage
      .from('resumes')
      .getPublicUrl(filePath);

    return { path: filePath, url: publicUrl };
  }

  async createResume(resume: Partial<Resume>): Promise<Resume> {
    const user = this._user.value;
    const profile = this._profile.value;
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('resumes')
      .insert({
        ...resume,
        user_id: user.id,
        organization_id: profile?.organization_id
      })
      .select()
      .single();

    if (error) throw error;
    await this.logActivity('resume_uploaded', 'resume', data.id, { file_name: resume.file_name });
    return data as Resume;
  }

  async getResumes(): Promise<Resume[]> {
    const { data, error } = await this.supabase
      .from('resumes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as Resume[];
  }

  async getResume(id: string): Promise<Resume | null> {
    const { data, error } = await this.supabase
      .from('resumes')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data as Resume;
  }

  async updateResume(id: string, updates: Partial<Resume>): Promise<Resume> {
    const { data, error } = await this.supabase
      .from('resumes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as Resume;
  }

  async setPrimaryResume(id: string): Promise<void> {
    const user = this._user.value;
    if (!user) throw new Error('Not authenticated');

    // Unset all primary
    await this.supabase
      .from('resumes')
      .update({ is_primary: false })
      .eq('user_id', user.id);

    // Set new primary
    await this.supabase
      .from('resumes')
      .update({ is_primary: true })
      .eq('id', id);
  }

  // ============================================================================
  // CANDIDATES (Deduplicated from Resumes)
  // ============================================================================

  /**
   * Get all candidates with deduplication logic.
   * Candidates are considered the same if they have the same name AND either the same email or phone.
   */
  async getCandidates(): Promise<Candidate[]> {
    const resumes = await this.getResumes();

    // Group resumes by candidate using deduplication logic
    const candidateMap = new Map<string, Candidate>();

    for (const resume of resumes) {
      const name = resume.candidate_name?.trim().toLowerCase() || '';
      const email = resume.candidate_email?.trim().toLowerCase() || '';
      const phone = this.normalizePhone(resume.candidate_phone);

      if (!name) continue; // Skip resumes without a name

      // Find existing candidate by name + (email OR phone)
      let existingCandidate: Candidate | undefined;
      let matchKey: string | undefined;

      for (const [key, candidate] of candidateMap.entries()) {
        const candidateName = candidate.name.toLowerCase();
        const candidateEmail = candidate.email?.toLowerCase() || '';
        const candidatePhone = this.normalizePhone(candidate.phone);

        if (candidateName === name) {
          // Same name - check if email or phone matches
          if ((email && candidateEmail && email === candidateEmail) ||
              (phone && candidatePhone && phone === candidatePhone)) {
            existingCandidate = candidate;
            matchKey = key;
            break;
          }
        }
      }

      if (existingCandidate && matchKey) {
        // Add resume to existing candidate
        existingCandidate.resumes.push(resume);
        existingCandidate.resume_count++;

        // Update with latest info if available
        if (resume.candidate_email && !existingCandidate.email) {
          existingCandidate.email = resume.candidate_email;
        }
        if (resume.candidate_phone && !existingCandidate.phone) {
          existingCandidate.phone = resume.candidate_phone;
        }
        if (resume.candidate_location && !existingCandidate.location) {
          existingCandidate.location = resume.candidate_location;
        }
        if (resume.candidate_linkedin && !existingCandidate.linkedin) {
          existingCandidate.linkedin = resume.candidate_linkedin;
        }
        if (resume.current_title && !existingCandidate.current_title) {
          existingCandidate.current_title = resume.current_title;
        }
        if (resume.current_company && !existingCandidate.current_company) {
          existingCandidate.current_company = resume.current_company;
        }
        if (resume.years_of_experience && (!existingCandidate.years_of_experience || resume.years_of_experience > existingCandidate.years_of_experience)) {
          existingCandidate.years_of_experience = resume.years_of_experience;
        }
        if (resume.experience_level && !existingCandidate.experience_level) {
          existingCandidate.experience_level = resume.experience_level;
        }

        // Merge skills
        if (resume.skills?.length) {
          const existingSkillNames = new Set(existingCandidate.skills.map(s => s.name.toLowerCase()));
          for (const skill of resume.skills) {
            if (!existingSkillNames.has(skill.name.toLowerCase())) {
              existingCandidate.skills.push(skill);
              existingSkillNames.add(skill.name.toLowerCase());
            }
          }
        }

        // Update timestamps
        if (new Date(resume.updated_at) > new Date(existingCandidate.last_updated)) {
          existingCandidate.last_updated = resume.updated_at;
        }
        if (new Date(resume.created_at) < new Date(existingCandidate.created_at)) {
          existingCandidate.created_at = resume.created_at;
        }
      } else {
        // Create new candidate
        const candidateId = this.generateCandidateId(resume);
        const newCandidate: Candidate = {
          id: candidateId,
          name: resume.candidate_name || 'Unknown',
          email: resume.candidate_email,
          phone: resume.candidate_phone,
          location: resume.candidate_location,
          linkedin: resume.candidate_linkedin,
          current_title: resume.current_title,
          current_company: resume.current_company,
          years_of_experience: resume.years_of_experience,
          experience_level: resume.experience_level,
          skills: resume.skills ? [...resume.skills] : [],
          resumes: [resume],
          resume_count: 1,
          last_updated: resume.updated_at,
          created_at: resume.created_at,
          preferences: null,
          documents: []
        };
        candidateMap.set(candidateId, newCandidate);
      }
    }

    // Convert to array and sort by last_updated
    return Array.from(candidateMap.values())
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
  }

  /**
   * Normalize phone number for comparison
   */
  private normalizePhone(phone: string | null): string {
    if (!phone) return '';
    return phone.replace(/[\s\-\(\)\+\.]/g, '');
  }

  /**
   * Generate a unique ID for a candidate based on resume data
   */
  private generateCandidateId(resume: Resume): string {
    const name = resume.candidate_name?.trim().toLowerCase() || '';
    const email = resume.candidate_email?.trim().toLowerCase() || '';
    const phone = this.normalizePhone(resume.candidate_phone);

    // Create a hash-like ID from the identifying info
    const identifier = `${name}-${email || phone || resume.id}`;
    return btoa(identifier).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  }

  /**
   * Get a specific candidate by ID
   */
  async getCandidate(candidateId: string): Promise<Candidate | null> {
    const candidates = await this.getCandidates();
    return candidates.find(c => c.id === candidateId) || null;
  }

  /**
   * Get all resumes for organization (admin view)
   */
  async getAllResumesForOrg(): Promise<Resume[]> {
    const profile = this._profile.value;
    if (!profile?.organization_id) return [];

    const { data, error } = await this.supabase
      .from('resumes')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as Resume[];
  }

  /**
   * Get all candidates for the organization (admin view)
   */
  async getAllCandidatesForOrg(): Promise<Candidate[]> {
    const profile = this._profile.value;
    if (!profile?.organization_id) return [];

    const { data: resumes, error } = await this.supabase
      .from('resumes')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Apply same deduplication logic
    return this.deduplicateResumesToCandidates(resumes as Resume[]);
  }

  /**
   * Shared deduplication logic
   */
  private deduplicateResumesToCandidates(resumes: Resume[]): Candidate[] {
    const candidateMap = new Map<string, Candidate>();

    for (const resume of resumes) {
      const name = resume.candidate_name?.trim().toLowerCase() || '';
      const email = resume.candidate_email?.trim().toLowerCase() || '';
      const phone = this.normalizePhone(resume.candidate_phone);

      if (!name) continue;

      let existingCandidate: Candidate | undefined;
      let matchKey: string | undefined;

      for (const [key, candidate] of candidateMap.entries()) {
        const candidateName = candidate.name.toLowerCase();
        const candidateEmail = candidate.email?.toLowerCase() || '';
        const candidatePhone = this.normalizePhone(candidate.phone);

        if (candidateName === name) {
          if ((email && candidateEmail && email === candidateEmail) ||
              (phone && candidatePhone && phone === candidatePhone)) {
            existingCandidate = candidate;
            matchKey = key;
            break;
          }
        }
      }

      if (existingCandidate && matchKey) {
        existingCandidate.resumes.push(resume);
        existingCandidate.resume_count++;

        // Update with latest info
        if (resume.candidate_email && !existingCandidate.email) {
          existingCandidate.email = resume.candidate_email;
        }
        if (resume.candidate_phone && !existingCandidate.phone) {
          existingCandidate.phone = resume.candidate_phone;
        }
        if (resume.candidate_location && !existingCandidate.location) {
          existingCandidate.location = resume.candidate_location;
        }
        if (resume.candidate_linkedin && !existingCandidate.linkedin) {
          existingCandidate.linkedin = resume.candidate_linkedin;
        }
        if (resume.current_title && !existingCandidate.current_title) {
          existingCandidate.current_title = resume.current_title;
        }
        if (resume.current_company && !existingCandidate.current_company) {
          existingCandidate.current_company = resume.current_company;
        }
        if (resume.years_of_experience && (!existingCandidate.years_of_experience || resume.years_of_experience > existingCandidate.years_of_experience)) {
          existingCandidate.years_of_experience = resume.years_of_experience;
        }
        if (resume.experience_level && !existingCandidate.experience_level) {
          existingCandidate.experience_level = resume.experience_level;
        }

        if (resume.skills?.length) {
          const existingSkillNames = new Set(existingCandidate.skills.map(s => s.name.toLowerCase()));
          for (const skill of resume.skills) {
            if (!existingSkillNames.has(skill.name.toLowerCase())) {
              existingCandidate.skills.push(skill);
              existingSkillNames.add(skill.name.toLowerCase());
            }
          }
        }

        if (new Date(resume.updated_at) > new Date(existingCandidate.last_updated)) {
          existingCandidate.last_updated = resume.updated_at;
        }
        if (new Date(resume.created_at) < new Date(existingCandidate.created_at)) {
          existingCandidate.created_at = resume.created_at;
        }
      } else {
        const candidateId = this.generateCandidateId(resume);
        const newCandidate: Candidate = {
          id: candidateId,
          name: resume.candidate_name || 'Unknown',
          email: resume.candidate_email,
          phone: resume.candidate_phone,
          location: resume.candidate_location,
          linkedin: resume.candidate_linkedin,
          current_title: resume.current_title,
          current_company: resume.current_company,
          years_of_experience: resume.years_of_experience,
          experience_level: resume.experience_level,
          skills: resume.skills ? [...resume.skills] : [],
          resumes: [resume],
          resume_count: 1,
          last_updated: resume.updated_at,
          created_at: resume.created_at,
          preferences: null,
          documents: []
        };
        candidateMap.set(candidateId, newCandidate);
      }
    }

    return Array.from(candidateMap.values())
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
  }

  // ============================================================================
  // JOBS
  // ============================================================================

  async createJob(job: Partial<Job>): Promise<Job> {
    const user = this._user.value;
    const profile = this._profile.value;
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('jobs')
      .insert({
        ...job,
        user_id: user.id,
        organization_id: profile?.organization_id
      })
      .select()
      .single();

    if (error) throw error;
    await this.logActivity('job_extracted', 'job', data.id, {
      platform: job.platform,
      company: job.company_name
    });
    return data as Job;
  }

  // Delete resume
  async deleteResume(id: string): Promise<void> {
    // First get the resume to get file URL
    const { data: resume } = await this.supabase
      .from('resumes')
      .select('file_url')
      .eq('id', id)
      .single();

    // Delete from storage if file exists
    if (resume?.file_url) {
      try {
        // Extract file path from URL
        const url = new URL(resume.file_url);
        const pathParts = url.pathname.split('/storage/v1/object/public/resumes/');
        if (pathParts[1]) {
          await this.supabase.storage
            .from('resumes')
            .remove([pathParts[1]]);
        }
      } catch (storageErr) {
        console.warn('Could not delete file from storage:', storageErr);
      }
    }

    // Delete from database
    const { error } = await this.supabase
      .from('resumes')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Log activity
    await this.supabase.rpc('log_activity', {
      p_action: 'resume_deleted',
      p_entity_type: 'resume',
      p_entity_id: id
    });
  }

  async getJobs(status?: string): Promise<Job[]> {
    let query = this.supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as Job[];
  }

  async getJob(id: string): Promise<Job | null> {
    const { data, error } = await this.supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data as Job;
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<Job> {
    const { data, error } = await this.supabase
      .from('jobs')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as Job;
  }

  async deleteJob(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('jobs')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  // ============================================================================
  // CANDIDATE DOCUMENTS
  // ============================================================================

  async uploadCandidateDocument(file: File, candidateId: string): Promise<{ path: string; url: string }> {
    const user = this._user.value;
    if (!user) throw new Error('Not authenticated');

    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}.${fileExt}`;
    const filePath = `${user.id}/documents/${candidateId}/${fileName}`;

    const { error: uploadError } = await this.supabase.storage
      .from('candidate-documents')
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    // For private buckets, store the path and generate signed URLs on-demand
    // Return the path as URL for now - we'll generate signed URLs when viewing
    return { path: filePath, url: filePath };
  }

  /**
   * Get a signed URL for accessing a document from the private bucket
   * @param filePath The file path stored in the database
   * @returns Signed URL valid for 1 hour
   */
  async getSignedDocumentUrl(filePath: string): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from('candidate-documents')
      .createSignedUrl(filePath, 3600); // 1 hour expiry

    if (error) throw error;
    return data.signedUrl;
  }

  async createCandidateDocument(document: Partial<CandidateDocument>): Promise<CandidateDocument> {
    const user = this._user.value;
    const profile = this._profile.value;
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('candidate_documents')
      .insert({
        ...document,
        user_id: user.id,
        organization_id: profile?.organization_id
      })
      .select()
      .single();

    if (error) throw error;
    return data as CandidateDocument;
  }

  async getCandidateDocuments(candidateId: string): Promise<CandidateDocument[]> {
    const { data, error } = await this.supabase
      .from('candidate_documents')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as CandidateDocument[];
  }

  async deleteCandidateDocument(id: string): Promise<void> {
    // First get the document to get file path
    const { data: doc } = await this.supabase
      .from('candidate_documents')
      .select('file_url')
      .eq('id', id)
      .single();

    // Delete from storage if file exists
    if (doc?.file_url) {
      try {
        // file_url now stores the path directly (not a full URL)
        await this.supabase.storage
          .from('candidate-documents')
          .remove([doc.file_url]);
      } catch (storageErr) {
        console.warn('Could not delete file from storage:', storageErr);
      }
    }

    // Delete from database
    const { error } = await this.supabase
      .from('candidate_documents')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  // ============================================================================
  // CANDIDATE PREFERENCES
  // ============================================================================

  async getCandidatePreferences(candidateId: string): Promise<CandidatePreferences | null> {
    const { data, error } = await this.supabase
      .from('candidate_preferences')
      .select('*')
      .eq('candidate_id', candidateId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows found
    return data as CandidatePreferences | null;
  }

  async saveCandidatePreferences(candidateId: string, preferences: Partial<CandidatePreferences>): Promise<CandidatePreferences> {
    const user = this._user.value;
    const profile = this._profile.value;
    if (!user) throw new Error('Not authenticated');

    // Check if preferences exist
    const { data: existing } = await this.supabase
      .from('candidate_preferences')
      .select('id')
      .eq('candidate_id', candidateId)
      .single();

    if (existing) {
      // Update existing
      const { data, error } = await this.supabase
        .from('candidate_preferences')
        .update(preferences)
        .eq('candidate_id', candidateId)
        .select()
        .single();

      if (error) throw error;
      return data as CandidatePreferences;
    } else {
      // Create new
      const { data, error } = await this.supabase
        .from('candidate_preferences')
        .insert({
          ...preferences,
          candidate_id: candidateId,
          user_id: user.id,
          organization_id: profile?.organization_id
        })
        .select()
        .single();

      if (error) throw error;
      return data as CandidatePreferences;
    }
  }

  // ============================================================================
  // JOB APPLICATIONS
  // ============================================================================

  async createApplication(application: Partial<JobApplication>): Promise<JobApplication> {
    const user = this._user.value;
    const profile = this._profile.value;
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('job_applications')
      .insert({
        ...application,
        user_id: user.id,
        organization_id: profile?.organization_id
      })
      .select()
      .single();

    if (error) throw error;

    // Update job status
    if (application.job_id) {
      await this.updateJob(application.job_id, { status: 'applied' });
    }

    await this.logActivity('application_submitted', 'application', data.id, {
      job_id: application.job_id
    });

    return data as JobApplication;
  }

  async getApplications(): Promise<UserApplicationView[]> {
    const { data, error } = await this.supabase
      .from('user_applications')
      .select('*')
      .order('applied_at', { ascending: false });

    if (error) throw error;
    return data as UserApplicationView[];
  }

  async getApplication(id: string): Promise<JobApplication | null> {
    const { data, error } = await this.supabase
      .from('job_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data as JobApplication;
  }

  async updateApplication(id: string, updates: Partial<JobApplication>): Promise<JobApplication> {
    const { data, error } = await this.supabase
      .from('job_applications')
      .update({
        ...updates,
        status_updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await this.logActivity('status_changed', 'application', id, {
      new_status: updates.status
    });

    return data as JobApplication;
  }

  // ============================================================================
  // ACTIVITY LOG
  // ============================================================================

  async logActivity(
    action: string,
    entityType?: string,
    entityId?: string,
    details: Record<string, any> = {}
  ): Promise<void> {
    try {
      await this.supabase.rpc('log_activity', {
        p_action: action,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_details: details
      });
    } catch (e) {
      console.warn('Failed to log activity:', e);
    }
  }

  // ============================================================================
  // USER DASHBOARD
  // ============================================================================

  async getUserDashboard(): Promise<UserDashboard | null> {
    const user = this._user.value;
    if (!user) return null;

    const { data, error } = await this.supabase
      .from('user_dashboard')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error) {
      console.error('Dashboard error:', error);
      return null;
    }
    return data as UserDashboard;
  }

  // ============================================================================
  // ADMIN DASHBOARD
  // ============================================================================

  async getAdminOrgDashboard(): Promise<AdminOrgDashboard | null> {
    const profile = this._profile.value;
    if (!profile?.organization_id || profile.role !== 'admin') return null;

    const { data, error } = await this.supabase
      .from('admin_org_dashboard')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .single();

    if (error) return null;
    return data as AdminOrgDashboard;
  }

  async getAdminEmployeeStats(): Promise<AdminEmployeeStats[]> {
    const profile = this._profile.value;
    if (!profile?.organization_id || profile.role !== 'admin') return [];

    const { data, error } = await this.supabase
      .from('admin_employee_stats')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('total_applications', { ascending: false });

    if (error) return [];
    return data as AdminEmployeeStats[];
  }

  // Add this new method for getting applications with job details
  async getApplicationsWithDetails(): Promise<UserApplicationView[]> {
    // First try the view
    const { data, error } = await this.supabase
      .from('user_applications')
      .select('*')
      .order('applied_at', { ascending: false });

    if (!error && data) {
      return data as UserApplicationView[];
    }

    // Fallback: manual join if view doesn't exist
    console.warn('user_applications view not found, using manual join');
    return this.getApplicationsManualJoin();
  }

  // Fallback method if view doesn't exist
  private async getApplicationsManualJoin(): Promise<UserApplicationView[]> {
    const { data: apps, error: appsError } = await this.supabase
      .from('job_applications')
      .select('*')
      .order('applied_at', { ascending: false });

    if (appsError) throw appsError;
    if (!apps || apps.length === 0) return [];

    // Get job details for each application
    const jobIds = [...new Set(apps.map(a => a.job_id).filter(Boolean))];

    let jobs: Job[] = [];
    if (jobIds.length > 0) {
      const { data: jobsData } = await this.supabase
        .from('jobs')
        .select('*')
        .in('id', jobIds);
      jobs = jobsData || [];
    }

    const jobMap = new Map(jobs.map(j => [j.id, j]));

    return apps.map(app => {
      const job = jobMap.get(app.job_id);
      return {
        id: app.id,
        user_id: app.user_id,
        job_id: app.job_id,
        resume_id: app.resume_id,
        job_title: job?.job_title || null,
        company_name: job?.company_name || null,
        platform: job?.platform || null,
        work_type: job?.work_type || null,
        location: job?.location || null,
        salary_min: job?.salary_min || null,
        salary_max: job?.salary_max || null,
        match_score: job?.match_score || null,
        experience_level: job?.experience_level || null,
        required_skills: job?.required_skills || [],
        status: app.status,
        applied_at: app.applied_at,
        next_step: app.next_step,
        next_step_date: app.next_step_date,
        interviews: app.interviews || [],
        offered_salary: app.offered_salary,
        outcome: app.outcome,
        notes: app.notes
      } as UserApplicationView;
    });
  }

  // Delete application
  async deleteApplication(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('job_applications')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await this.logActivity('application_deleted', 'application', id);
  }

  async getAdminActivityFeed(limit = 50): Promise<any[]> {
    const profile = this._profile.value;
    if (!profile?.organization_id || profile.role !== 'admin') return [];

    const { data, error } = await this.supabase
      .from('admin_activity_feed')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return [];
    return data;
  }

  async getAdminPipeline(): Promise<any | null> {
    const profile = this._profile.value;
    if (!profile?.organization_id || profile.role !== 'admin') return null;

    const { data, error } = await this.supabase
      .from('admin_pipeline')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .single();

    if (error) return null;
    return data;
  }

  async getOrgMembers(): Promise<Profile[]> {
    const profile = this._profile.value;
    if (!profile?.organization_id || profile.role !== 'admin') return [];

    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: true });

    if (error) return [];
    return data as Profile[];
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  get isAuthenticated(): boolean {
    return !!this._session.value;
  }

  get isAdmin(): boolean {
    return this._profile.value?.role === 'admin';
  }

  get currentUser(): User | null {
    return this._user.value;
  }

  get currentProfile(): Profile | null {
    return this._profile.value;
  }

  get supabaseClient(): SupabaseClient {
    return this.supabase;
  }
  // ============================================================================
  // AI EXTRACTION (Edge Functions)
  // ============================================================================

  async extractResumeWithAI(resumeText: string, fileName: string): Promise<Partial<Resume>> {
    const { data, error } = await this.supabase.functions.invoke('extract-resume', {
      body: { resumeText, fileName }
    });

    if (error) throw error;
    return data;
  }

  async extractJobWithAI(jobDescription: string, jobUrl: string, platform: string): Promise<Partial<Job>> {
    const { data, error } = await this.supabase.functions.invoke('extract-job', {
      body: { jobDescription, jobUrl, platform }
    });

    if (error) throw error;
    return data;
  }

  async analyzeMatchWithAI(resume: Resume, job: Partial<Job>): Promise<{
    match_score: number;
    matching_skills: string[];
    missing_skills: string[];
    recommendations: string[];
    overall_assessment: string;
  }> {
    const { data, error } = await this.supabase.functions.invoke('analyze-match', {
      body: { resume, job }
    });

    if (error) throw error;
    return data;
  }

  async extractResumeFromUrl(fileUrl: string, fileName: string): Promise<Partial<Resume>> {
    console.log('Calling extract-resume-from-url Edge Function...');

    const { data, error } = await this.supabase.functions.invoke('extract-resume-from-url', {
      body: { fileUrl, fileName }
    });

    if (error) {
      console.error('extract-resume-from-url error:', error);
      throw new Error(error.message || 'Failed to extract resume');
    }

    if (data?.error) {
      console.error('extract-resume-from-url API error:', data.error);
      throw new Error(data.error);
    }

    console.log('extract-resume-from-url success:', data);
    return data;
  }

  // ============================================================================
  // ADMIN METHODS
  // ============================================================================
  async getAdminApplications(): Promise<any[]> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');

    const { data, error } = await this.supabase
      .from('job_applications')
      .select(`
      id,
      user_id,
      job_id,
      resume_id,
      status,
      applied_at,
      profiles!job_applications_user_id_fkey (
        full_name,
        email
      ),
      jobs!job_applications_job_id_fkey (
        job_title,
        company_name,
        platform,
        location,
        work_type,
        salary_min,
        salary_max,
        match_score,
        experience_level,
        required_skills
      )
    `)
      .eq('organization_id', profile.organization_id)
      .order('applied_at', { ascending: false });

    if (error) throw error;

    // Transform the data
    return (data || []).map(app => ({
      id: app.id,
      user_id: app.user_id,
      job_id: app.job_id,
      resume_id: app.resume_id,
      status: app.status,
      applied_at: app.applied_at,
      recruiter_name: (app.profiles as any)?.full_name,
      recruiter_email: (app.profiles as any)?.email,
      job_title: (app.jobs as any)?.job_title,
      company_name: (app.jobs as any)?.company_name,
      platform: (app.jobs as any)?.platform,
      location: (app.jobs as any)?.location,
      work_type: (app.jobs as any)?.work_type,
      salary_min: (app.jobs as any)?.salary_min,
      salary_max: (app.jobs as any)?.salary_max,
      match_score: (app.jobs as any)?.match_score,
      experience_level: (app.jobs as any)?.experience_level,
      required_skills: (app.jobs as any)?.required_skills
    }));
  }

  async getAdminRecruiterStats(): Promise<any[]> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');

    const { data, error } = await this.supabase
      .from('profiles')
      .select(`
      id,
      full_name,
      email,
      avatar_url,
      role,
      last_active_at
    `)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    // Get application stats for each recruiter
    const recruitersWithStats = await Promise.all(
      (data || []).map(async (recruiter) => {
        const { data: apps } = await this.supabase
          .from('job_applications')
          .select('status')
          .eq('user_id', recruiter.id);

        const applications = apps || [];
        return {
          user_id: recruiter.id,
          full_name: recruiter.full_name,
          email: recruiter.email,
          avatar_url: recruiter.avatar_url,
          role: recruiter.role || 'recruiter',  // Include role
          last_active_at: recruiter.last_active_at,
          total_applications: applications.length,
          interviews: applications.filter(a =>
            ['screening', 'interviewing', 'offer', 'accepted'].includes(a.status)
          ).length,
          offers: applications.filter(a =>
            ['offer', 'accepted'].includes(a.status)
          ).length
        };
      })
    );

    return recruitersWithStats;
  }

  // ============================================================================
  // USER MANAGEMENT (Admin)
  // ============================================================================

  async inviteUserToOrganization(
    email: string,
    fullName: string,
    role: 'admin' | 'user'
  ): Promise<void> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');
    if (profile.role !== 'admin') throw new Error('Only admins can invite users');

    // Check if user already exists (use maybeSingle instead of single)
    const { data: existingUser, error: lookupError } = await this.supabase
      .from('profiles')
      .select('id, organization_id, full_name')
      .eq('email', email.toLowerCase())
      .maybeSingle();  // This returns null instead of error when no rows found

    if (lookupError) throw lookupError;

    if (existingUser) {
      if (existingUser.organization_id === profile.organization_id) {
        throw new Error('This user is already in your organization');
      }
      if (existingUser.organization_id) {
        throw new Error('This user belongs to another organization');
      }

      // Add existing user to this org
      const { error } = await this.supabase
        .from('profiles')
        .update({
          organization_id: profile.organization_id,
          role: role,
          full_name: fullName || existingUser.full_name
        })
        .eq('id', existingUser.id);

      if (error) throw error;
      return;
    }

    // User doesn't exist yet - create an invitation
    const { error } = await this.supabase
      .from('organization_invites')
      .insert({
        organization_id: profile.organization_id,
        email: email.toLowerCase(),
        full_name: fullName,
        role: role,
        invited_by: profile.id,
        status: 'pending'
      });

    if (error) {
      if (error.code === '23505') {
        throw new Error('This email has already been invited');
      }
      throw error;
    }
  }

  /**
   * Update a user's role within the organization
   */
  async updateUserRole(userId: string, newRole: 'admin' | 'recruiter'): Promise<void> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');
    if (profile.role !== 'admin') throw new Error('Only admins can update roles');

    const { error } = await this.supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;
  }

  /**
   * Remove a user from the organization
   */
  async removeUserFromOrganization(userId: string): Promise<void> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');
    if (profile.role !== 'admin') throw new Error('Only admins can remove users');
    if (profile.id === userId) throw new Error('Cannot remove yourself');

    const { error } = await this.supabase
      .from('profiles')
      .update({
        organization_id: null,
        role: 'recruiter'  // Reset role when removed
      })
      .eq('id', userId)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;
  }

  /**
   * Get pending invitations for the organization
   */
  async getOrganizationInvites(): Promise<any[]> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');

    const { data, error } = await this.supabase
      .from('organization_invites')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Cancel/delete a pending invitation
   */
  async cancelInvitation(inviteId: string): Promise<void> {
    const profile = await this.getProfile();
    if (!profile?.organization_id) throw new Error('No organization');
    if (profile.role !== 'admin') throw new Error('Only admins can cancel invitations');

    const { error } = await this.supabase
      .from('organization_invites')
      .delete()
      .eq('id', inviteId)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;
  }

  // ============================================================================
  // INVITATION SYSTEM
  // ============================================================================

  /**
   * Check if current user has a pending invitation
   */
  async getPendingInvitation(): Promise<any | null> {
    const { data: { user } } = await this.supabase.auth.getUser();
    if (!user?.email) return null;

    const { data, error } = await this.supabase
      .from('organization_invites')
      .select(`
      *,
      organizations!organization_invites_organization_id_fkey (name)
    `)
      .eq('email', user.email.toLowerCase())
      .eq('status', 'pending')
      .maybeSingle();

    if (error) {
      console.error('Error checking invitation:', error);
      return null;
    }

    if (!data) return null;

    return {
      ...data,
      organization_name: (data.organizations as any)?.name || 'Unknown Organization'
    };
  }

  /**
   * Accept a pending invitation
   */
  async acceptInvitation(): Promise<void> {
    const { data: { user } } = await this.supabase.auth.getUser();
    if (!user?.email) throw new Error('Not authenticated');

    // Get the pending invitation
    const { data: invite, error: inviteError } = await this.supabase
      .from('organization_invites')
      .select('*')
      .eq('email', user.email.toLowerCase())
      .eq('status', 'pending')
      .maybeSingle();

    if (inviteError) throw inviteError;
    if (!invite) throw new Error('No pending invitation found');

    // Update profile with organization and role from invitation
    const { error: updateError } = await this.supabase
      .from('profiles')
      .update({
        organization_id: invite.organization_id,
        role: invite.role,
        full_name: invite.full_name
      })
      .eq('id', user.id);

    if (updateError) throw updateError;

    // Mark invitation as accepted
    await this.supabase
      .from('organization_invites')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString()
      })
      .eq('id', invite.id);

    // Reload profile
    await this.loadProfile(user.id);
  }
}
