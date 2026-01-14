import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { JobFeedService, ExternalJob, JobSearchParams } from './job-feed.service';
import { VendorEmailService, VendorJob } from './vendor-email.service';
import { UnifiedJob, UnifiedFeedState } from '../models/unified-job.model';
import { CandidatePreferences } from '../models';

const SEEN_JOBS_STORAGE_KEY = 'jobFeed_seenJobIds';
const FEED_STATE_STORAGE_KEY = 'jobFeed_unifiedState';

@Injectable({
  providedIn: 'root'
})
export class UnifiedFeedService {
  // State
  private stateSubject = new BehaviorSubject<UnifiedFeedState>({
    jobs: [],
    lastRefreshTime: null,
    isRefreshing: false,
    newJobsCount: 0,
    seenJobIds: new Set(),
    sourceFilter: 'all',
    sortBy: 'date'
  });

  // Track known job IDs to detect new jobs
  private knownJobIds = new Set<string>();

  // Public observables
  state$ = this.stateSubject.asObservable();

  // Convenience observables
  get jobs$(): Observable<UnifiedJob[]> {
    return new BehaviorSubject(this.stateSubject.value.jobs).asObservable();
  }

  get newJobsCount$(): Observable<number> {
    return new BehaviorSubject(this.stateSubject.value.newJobsCount).asObservable();
  }

  constructor(
    private jobFeedService: JobFeedService,
    private vendorEmailService: VendorEmailService
  ) {
    this.loadSeenJobIds();
  }

  /**
   * Get current state
   */
  getState(): UnifiedFeedState {
    return this.stateSubject.value;
  }

  /**
   * Get all jobs (optionally filtered)
   */
  getJobs(filter?: 'all' | 'api' | 'email'): UnifiedJob[] {
    const jobs = this.stateSubject.value.jobs;
    if (!filter || filter === 'all') return jobs;
    return jobs.filter(job => job.source_type === filter);
  }

  /**
   * Refresh the entire feed
   * Fetches from both API sources and email jobs
   */
  async refreshFeed(preferences: CandidatePreferences | null, options?: {
    maxJobsPerSource?: number;
    syncGmail?: boolean;
  }): Promise<{ apiJobs: number; emailJobs: number; newJobs: number }> {
    const maxJobs = options?.maxJobsPerSource || 30;
    const syncGmail = options?.syncGmail !== false;

    this.updateState({ isRefreshing: true });

    try {
      // Build search queries from preferences
      const searchQueries = this.buildSearchQueries(preferences);

      // Fetch from all sources in parallel
      const [apiJobsResult, emailJobsResult] = await Promise.all([
        this.fetchApiJobs(searchQueries, maxJobs),
        this.fetchEmailJobs(syncGmail)
      ]);

      // Normalize all jobs to UnifiedJob format
      const normalizedApiJobs = apiJobsResult.map(job => this.normalizeApiJob(job));
      const normalizedEmailJobs = emailJobsResult.map(job => this.normalizeVendorJob(job));

      // Combine and deduplicate
      const allJobs = [...normalizedApiJobs, ...normalizedEmailJobs];
      const deduplicatedJobs = this.deduplicateJobs(allJobs);

      // Mark new jobs
      const newJobsCount = this.markNewJobs(deduplicatedJobs);

      // Sort jobs
      const sortedJobs = this.sortJobs(deduplicatedJobs, this.stateSubject.value.sortBy);

      // Update state
      this.updateState({
        jobs: sortedJobs,
        lastRefreshTime: new Date(),
        isRefreshing: false,
        newJobsCount
      });

      // Update known job IDs
      sortedJobs.forEach(job => this.knownJobIds.add(job.id));

      // Auto-save state
      this.saveState();

      return {
        apiJobs: normalizedApiJobs.length,
        emailJobs: normalizedEmailJobs.length,
        newJobs: newJobsCount
      };
    } catch (error) {
      console.error('Failed to refresh feed:', error);
      this.updateState({ isRefreshing: false });
      throw error;
    }
  }

  /**
   * Fetch only email jobs (vendor jobs)
   */
  async refreshEmailJobsOnly(): Promise<number> {
    const emailJobs = await this.fetchEmailJobs(true);
    const normalizedJobs = emailJobs.map(job => this.normalizeVendorJob(job));

    // Merge with existing API jobs
    const currentJobs = this.stateSubject.value.jobs.filter(j => j.source_type === 'api');
    const allJobs = [...currentJobs, ...normalizedJobs];
    const deduplicatedJobs = this.deduplicateJobs(allJobs);
    const newJobsCount = this.markNewJobs(deduplicatedJobs);
    const sortedJobs = this.sortJobs(deduplicatedJobs, this.stateSubject.value.sortBy);

    this.updateState({
      jobs: sortedJobs,
      lastRefreshTime: new Date(),
      newJobsCount
    });

    return normalizedJobs.length;
  }

  /**
   * Mark a job as seen
   */
  markAsSeen(jobId: string): void {
    const state = this.stateSubject.value;
    const seenJobIds = new Set(state.seenJobIds);
    seenJobIds.add(jobId);

    // Update the job's is_new flag
    const jobs = state.jobs.map(job => {
      if (job.id === jobId) {
        return { ...job, is_new: false, is_seen: true };
      }
      return job;
    });

    const newJobsCount = jobs.filter(j => j.is_new).length;

    this.updateState({ jobs, seenJobIds, newJobsCount });
    this.saveSeenJobIds(seenJobIds);
  }

  /**
   * Mark all jobs as seen
   */
  markAllAsSeen(): void {
    const state = this.stateSubject.value;
    const seenJobIds = new Set(state.seenJobIds);

    const jobs = state.jobs.map(job => {
      seenJobIds.add(job.id);
      return { ...job, is_new: false, is_seen: true };
    });

    this.updateState({ jobs, seenJobIds, newJobsCount: 0 });
    this.saveSeenJobIds(seenJobIds);
  }

  /**
   * Set source filter
   */
  setSourceFilter(filter: 'all' | 'api' | 'email'): void {
    this.updateState({ sourceFilter: filter });
  }

  /**
   * Set sort order
   */
  setSortBy(sortBy: 'date' | 'match' | 'salary'): void {
    const sortedJobs = this.sortJobs(this.stateSubject.value.jobs, sortBy);
    this.updateState({ jobs: sortedJobs, sortBy });
  }

  /**
   * Update a job's analysis results
   */
  updateJobAnalysis(jobId: string, analysis: {
    match_score: number;
    matching_skills: string[];
    missing_skills: string[];
  }): void {
    const jobs = this.stateSubject.value.jobs.map(job => {
      if (job.id === jobId) {
        return {
          ...job,
          match_score: analysis.match_score,
          matching_skills: analysis.matching_skills,
          missing_skills: analysis.missing_skills,
          analyzed: true,
          analyzing: false,
          analysis_timestamp: new Date().toISOString()
        };
      }
      return job;
    });

    this.updateState({ jobs });

    // Auto-save after analysis update
    this.saveState();
  }

  /**
   * Set job analyzing state
   */
  setJobAnalyzing(jobId: string, analyzing: boolean): void {
    const jobs = this.stateSubject.value.jobs.map(job => {
      if (job.id === jobId) {
        return { ...job, analyzing };
      }
      return job;
    });

    this.updateState({ jobs });
  }

  /**
   * Clear all analysis results (e.g., when resume changes)
   */
  clearAnalysisResults(): void {
    const jobs = this.stateSubject.value.jobs.map(job => ({
      ...job,
      match_score: undefined,
      matching_skills: undefined,
      missing_skills: undefined,
      analyzed: false,
      analyzing: false,
      analysis_timestamp: undefined
    }));

    this.updateState({ jobs });
  }

  /**
   * Get unanalyzed jobs
   */
  getUnanalyzedJobs(): UnifiedJob[] {
    return this.stateSubject.value.jobs.filter(job => !job.analyzed && !job.analyzing);
  }

  /**
   * Get filtered and sorted jobs based on current state
   */
  getFilteredJobs(): UnifiedJob[] {
    const state = this.stateSubject.value;
    let jobs = state.jobs;

    // Apply source filter
    if (state.sourceFilter !== 'all') {
      jobs = jobs.filter(job => job.source_type === state.sourceFilter);
    }

    return jobs;
  }

  // Private methods

  private buildSearchQueries(preferences: CandidatePreferences | null): JobSearchParams[] {
    if (!preferences) {
      return [{ query: 'software engineer', location: '' }];
    }

    const queries: JobSearchParams[] = [];

    // Use preferred job titles (up to 3)
    const titles = preferences.preferred_job_titles?.slice(0, 3) || [];
    const locations = preferences.preferred_locations?.slice(0, 2) || [''];

    if (titles.length === 0) {
      titles.push('software engineer'); // Default fallback
    }

    // Create search queries for each title-location combination
    for (const title of titles) {
      for (const location of locations) {
        queries.push({
          query: title,
          location: location || undefined,
          workType: preferences.preferred_work_type?.[0],
          resultsPerPage: 20
        });
      }
    }

    // Limit to 4 queries max to avoid rate limiting
    return queries.slice(0, 4);
  }

  private async fetchApiJobs(queries: JobSearchParams[], maxTotal: number): Promise<ExternalJob[]> {
    const allJobs: ExternalJob[] = [];
    const seenIds = new Set<string>();

    for (const query of queries) {
      if (allJobs.length >= maxTotal) break;

      try {
        // Try Adzuna first
        const adzunaResult = await this.jobFeedService.searchAdzunaJobs(query);
        for (const job of adzunaResult.jobs) {
          if (!seenIds.has(job.id) && allJobs.length < maxTotal) {
            seenIds.add(job.id);
            allJobs.push(job);
          }
        }

        // If not enough, try RapidAPI
        if (allJobs.length < maxTotal / 2) {
          const rapidResult = await this.jobFeedService.searchRapidApiJobs(query);
          for (const job of rapidResult.jobs) {
            if (!seenIds.has(job.id) && allJobs.length < maxTotal) {
              seenIds.add(job.id);
              allJobs.push(job);
            }
          }
        }
      } catch (error) {
        console.error('Error fetching API jobs for query:', query, error);
      }
    }

    return allJobs;
  }

  private async fetchEmailJobs(syncGmail: boolean): Promise<VendorJob[]> {
    try {
      // Check Gmail status first
      const gmailStatus = await this.vendorEmailService.getGmailStatus();

      // Sync Gmail if connected and requested
      if (syncGmail && gmailStatus.connected) {
        try {
          await this.vendorEmailService.syncGmailEmails({
            syncType: 'incremental',
            maxEmails: 50
          });
        } catch (syncError) {
          console.error('Gmail sync error (continuing with cached jobs):', syncError);
        }
      }

      // Fetch all vendor jobs
      return await this.vendorEmailService.getVendorJobs({ limit: 100 });
    } catch (error) {
      console.error('Error fetching email jobs:', error);
      return [];
    }
  }

  private normalizeApiJob(job: ExternalJob): UnifiedJob {
    return {
      id: `api-${job.source}-${job.id}`,
      source_type: 'api',
      source_platform: job.source,

      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      url: job.url,

      posted_date: job.posted_date,
      discovered_at: new Date().toISOString(),

      salary_min: job.salary_min,
      salary_max: job.salary_max,
      salary_text: job.salary_text,

      employment_type: job.employment_type,
      work_arrangement: this.normalizeWorkArrangement(job.work_type),

      required_skills: job.required_skills,

      analyzed: false,
      analyzing: false,
      is_new: true,
      is_seen: false
    };
  }

  private normalizeVendorJob(job: VendorJob): UnifiedJob {
    return {
      id: `email-${job.id}`,
      source_type: 'email',
      source_platform: 'gmail',

      title: job.job_title,
      company: job.client_company || job.vendor_company || 'Unknown Company',
      location: job.location || '',
      description: job.job_description || '',
      url: undefined,

      posted_date: job.email_received_at || job.created_at,
      discovered_at: job.created_at,

      salary_min: job.pay_rate_min,
      salary_max: job.pay_rate_max,
      salary_text: job.pay_rate,
      pay_rate_type: job.pay_rate_type,

      employment_type: job.employment_type,
      work_arrangement: job.work_arrangement,
      duration: job.duration,

      required_skills: job.required_skills,
      tech_stack: job.tech_stack,
      years_experience: job.years_experience,
      certifications: job.certifications,

      analyzed: false,
      analyzing: false,
      is_new: true,
      is_seen: false,

      // Email-specific fields
      vendor_job_id: job.id,
      recruiter_name: job.recruiter_name,
      recruiter_email: job.recruiter_email,
      recruiter_phone: job.recruiter_phone,
      recruiter_title: job.recruiter_title,
      vendor_company: job.vendor_company,
      client_company: job.client_company,
      email_subject: job.email_subject,
      email_received_at: job.email_received_at,
      special_requirements: job.special_requirements,
      status: job.status
    };
  }

  private normalizeWorkArrangement(workType?: string): UnifiedJob['work_arrangement'] {
    if (!workType) return 'unknown';
    const lower = workType.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('hybrid')) return 'hybrid';
    if (lower.includes('onsite') || lower.includes('on-site') || lower.includes('office')) return 'onsite';
    return 'unknown';
  }

  private deduplicateJobs(jobs: UnifiedJob[]): UnifiedJob[] {
    const seen = new Map<string, UnifiedJob>();

    for (const job of jobs) {
      const key = this.generateJobKey(job);
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, job);
      } else {
        // Prefer email jobs over API jobs (more detailed)
        if (job.source_type === 'email' && existing.source_type === 'api') {
          seen.set(key, job);
        }
        // Keep the newer job if same source type
        else if (job.source_type === existing.source_type) {
          const jobDate = new Date(job.posted_date);
          const existingDate = new Date(existing.posted_date);
          if (jobDate > existingDate) {
            seen.set(key, job);
          }
        }
      }
    }

    return Array.from(seen.values());
  }

  private generateJobKey(job: UnifiedJob): string {
    // Normalize title and company for comparison
    // Keep spaces to maintain better title differentiation
    const normalizedTitle = job.title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')  // Keep spaces
      .replace(/\s+/g, ' ')           // Normalize multiple spaces to single space
      .trim();
    const normalizedCompany = job.company.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Include location as well to differentiate same title/company in different locations
    const normalizedLocation = (job.location || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return `${normalizedTitle}|${normalizedCompany}|${normalizedLocation}`;
  }

  private markNewJobs(jobs: UnifiedJob[]): number {
    const seenJobIds = this.stateSubject.value.seenJobIds;
    let newCount = 0;

    for (const job of jobs) {
      if (!this.knownJobIds.has(job.id) && !seenJobIds.has(job.id)) {
        job.is_new = true;
        newCount++;
      } else {
        job.is_new = false;
        job.is_seen = seenJobIds.has(job.id);
      }
    }

    return newCount;
  }

  private sortJobs(jobs: UnifiedJob[], sortBy: 'date' | 'match' | 'salary'): UnifiedJob[] {
    return [...jobs].sort((a, b) => {
      switch (sortBy) {
        case 'date':
          return new Date(b.posted_date).getTime() - new Date(a.posted_date).getTime();

        case 'match':
          const scoreA = a.match_score ?? -1;
          const scoreB = b.match_score ?? -1;
          if (scoreA === scoreB) {
            return new Date(b.posted_date).getTime() - new Date(a.posted_date).getTime();
          }
          return scoreB - scoreA;

        case 'salary':
          const salaryA = a.salary_max || a.salary_min || 0;
          const salaryB = b.salary_max || b.salary_min || 0;
          if (salaryA === salaryB) {
            return new Date(b.posted_date).getTime() - new Date(a.posted_date).getTime();
          }
          return salaryB - salaryA;

        default:
          return 0;
      }
    });
  }

  private updateState(updates: Partial<UnifiedFeedState>): void {
    this.stateSubject.next({
      ...this.stateSubject.value,
      ...updates
    });
  }

  private loadSeenJobIds(): void {
    try {
      const stored = localStorage.getItem(SEEN_JOBS_STORAGE_KEY);
      if (stored) {
        const ids = JSON.parse(stored);
        this.updateState({ seenJobIds: new Set(ids) });
      }
    } catch (e) {
      console.error('Failed to load seen job IDs:', e);
    }
  }

  private saveSeenJobIds(seenJobIds: Set<string>): void {
    try {
      // Only keep the last 1000 seen job IDs to prevent localStorage overflow
      const idsArray = Array.from(seenJobIds).slice(-1000);
      localStorage.setItem(SEEN_JOBS_STORAGE_KEY, JSON.stringify(idsArray));
    } catch (e) {
      console.error('Failed to save seen job IDs:', e);
    }
  }

  // ============ Persistence Methods ============

  /**
   * Save current state to localStorage
   */
  saveState(): void {
    try {
      const state = this.stateSubject.value;
      const persistedState = {
        jobs: state.jobs,
        lastRefreshTime: state.lastRefreshTime?.toISOString() || null,
        sourceFilter: state.sourceFilter,
        sortBy: state.sortBy,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(FEED_STATE_STORAGE_KEY, JSON.stringify(persistedState));
    } catch (e) {
      console.error('Failed to save unified feed state:', e);
    }
  }

  /**
   * Load state from localStorage
   * Returns true if state was successfully loaded
   */
  loadState(): boolean {
    try {
      const stored = localStorage.getItem(FEED_STATE_STORAGE_KEY);
      if (stored) {
        const persistedState = JSON.parse(stored);

        // Check if saved data is less than 24 hours old
        const savedAt = new Date(persistedState.savedAt);
        const hoursSinceSave = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceSave < 24 && persistedState.jobs?.length > 0) {
          // Restore jobs to known IDs set
          persistedState.jobs.forEach((job: UnifiedJob) => this.knownJobIds.add(job.id));

          this.updateState({
            jobs: persistedState.jobs,
            lastRefreshTime: persistedState.lastRefreshTime ? new Date(persistedState.lastRefreshTime) : null,
            sourceFilter: persistedState.sourceFilter || 'all',
            sortBy: persistedState.sortBy || 'date',
            newJobsCount: persistedState.jobs.filter((j: UnifiedJob) => j.is_new).length
          });

          return true;
        }
      }
    } catch (e) {
      console.error('Failed to load unified feed state:', e);
    }
    return false;
  }

  /**
   * Set jobs directly (for restoring from session)
   */
  setJobs(jobs: UnifiedJob[]): void {
    // Add to known IDs
    jobs.forEach(job => this.knownJobIds.add(job.id));

    const newJobsCount = jobs.filter(j => j.is_new).length;
    this.updateState({ jobs, newJobsCount });
  }

  /**
   * Clear persisted state
   */
  clearState(): void {
    try {
      localStorage.removeItem(FEED_STATE_STORAGE_KEY);
      this.knownJobIds.clear();
      this.updateState({
        jobs: [],
        lastRefreshTime: null,
        newJobsCount: 0
      });
    } catch (e) {
      console.error('Failed to clear unified feed state:', e);
    }
  }

  /**
   * Update new jobs count based on current jobs
   */
  private updateNewJobsCount(): void {
    const jobs = this.stateSubject.value.jobs;
    const newJobsCount = jobs.filter(j => j.is_new).length;
    this.updateState({ newJobsCount });
  }
}
