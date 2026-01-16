import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClientModule } from '@angular/common/http';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Candidate, Profile, Resume, UnifiedJob } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { JobFeedService, ExternalJob, JobSearchParams, JobPlatform } from '../../../core/services/job-feed.service';
import { VendorEmailService, VendorJob, VendorJobStats, GmailConnectionStatus, GmailSyncResult } from '../../../core/services/vendor-email.service';
import { AutoRefreshService } from '../../../core/services/auto-refresh.service';
import { UnifiedFeedService } from '../../../core/services/unified-feed.service';
import { AnalysisQueueService } from '../../../core/services/analysis-queue.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

interface JobWithMatch extends ExternalJob {
  match_score?: number;
  matching_skills?: string[];
  missing_skills?: string[];
  analyzing?: boolean;
  analyzed?: boolean;
}

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, SidebarComponent],
  templateUrl: './job-feed.component.html',
  styleUrl: './job-feed.component.scss'
})
export class JobFeedComponent implements OnInit, OnDestroy {
  Math = Math; // Expose Math for template
  private destroy$ = new Subject<void>();

  profile: Profile | null = null;
  jobs: JobWithMatch[] = [];
  loading = false;
  searching = false;

  // Unified Feed
  unifiedJobs: UnifiedJob[] = [];
  sourceFilter: 'all' | 'api' | 'email' = 'all';
  sortBy: 'date' | 'match' | 'salary' = 'date';
  newJobsCount = 0;

  // Auto-Refresh State
  isRefreshing = false;
  lastRefreshTime: Date | null = null;
  refreshCountdown = '';
  autoRefreshPaused = false;

  // Analysis Progress
  analysisInProgress = false;
  analysisProgress = 0;
  totalToAnalyze = 0;

  // Candidates & Resumes
  candidates: Candidate[] = [];
  selectedCandidateId = '';
  selectedResumeId = '';
  showCandidateDrawer = false;
  candidateSearchQuery = '';

  // Search params
  searchQuery = '';
  searchLocation = '';
  selectedSource: JobPlatform = 'adzuna';

  // Available job platforms
  jobPlatforms: { value: JobPlatform; label: string; isAI?: boolean }[] = [
    { value: 'adzuna', label: 'Adzuna' },
    { value: 'rapidapi', label: 'JSearch (RapidAPI)' },
    { value: 'dice', label: 'Dice (AI)', isAI: true },
    { value: 'linkedin', label: 'LinkedIn (AI)', isAI: true },
    { value: 'indeed', label: 'Indeed (AI)', isAI: true },
    { value: 'glassdoor', label: 'Glassdoor (AI)', isAI: true },
    { value: 'ai-search', label: 'AI Search (All Platforms)', isAI: true },
    { value: 'all', label: 'All Sources' }
  ];

  // AI search platforms to include
  aiSearchPlatforms = ['dice', 'indeed', 'linkedin', 'glassdoor'];

  // Preference-based search
  usePreferences = true;

  // Pagination
  currentPage = 1;
  totalJobs = 0;
  totalPages = 0;
  resultsPerPage = 20;

  // Selected job for preview
  selectedJob: JobWithMatch | null = null;

  // Analyzing state
  analyzingAll = false;
  analyzedCount = 0;

  // Stats
  stats = {
    totalFound: 0,
    averageSalary: 0,
    avgMatchScore: 0
  };

  // Popular searches
  popularSearches = [
    'Software Engineer',
    'Data Scientist',
    'Product Manager',
    'UX Designer',
    'DevOps Engineer',
    'Frontend Developer',
    'Backend Developer',
    'Full Stack Developer'
  ];

  // Search loading text
  searchLoadingText = 'Connecting to job sources...';

  // Vendor Jobs
  vendorJobs: VendorJob[] = [];
  vendorJobStats: VendorJobStats | null = null;
  loadingVendorJobs = false;
  showVendorSection = false;
  vendorStatusFilter = '';
  showAddVendorJobModal = false;
  vendorEmailInput = '';
  parsingVendorEmail = false;
  parseError = '';
  selectedVendorJob: VendorJob | null = null;

  // Vendor Jobs Pagination
  vendorJobsPage = 1;
  vendorJobsPerPage = 10;
  vendorJobsTotal = 0;
  vendorJobsTotalPages = 0;

  // Gmail Integration
  gmailStatus: GmailConnectionStatus = { connected: false };
  gmailAccounts: any[] = []; // CandidateGmailAccount[]
  canAddMoreGmail = false;
  gmailConnecting = false;
  gmailSyncing = false;
  gmailSyncResult: GmailSyncResult | null = null;
  showGmailSettings = false;
  showGmailPanel = false; // For header Gmail panel

  // View Toggle
  activeView: 'search' | 'email' = 'search';

  // Session state key
  private readonly SESSION_STATE_KEY = 'jobFeed_sessionState';

  constructor(
    private supabase: SupabaseService,
    private jobFeedService: JobFeedService,
    private vendorEmailService: VendorEmailService,
    private autoRefreshService: AutoRefreshService,
    private unifiedFeedService: UnifiedFeedService,
    private analysisQueueService: AnalysisQueueService,
    private router: Router
  ) {}

  async ngOnInit() {
    // Restore session state first
    this.restoreSessionState();

    // Setup unified feed subscriptions early
    this.setupUnifiedFeedSubscriptions();

    // Try to load persisted unified feed state from localStorage
    const hasPersistedFeed = this.unifiedFeedService.loadState();

    await this.loadProfile();
    await this.loadCandidates();
    await this.loadVendorJobStats();
    await this.checkGmailStatus();

    // Check for OAuth callback or successful Gmail connection
    this.handleGmailCallback();
    this.handleGmailConnected();

    // Start auto-refresh if candidate is already selected
    if (this.selectedCandidateId) {
      this.autoRefreshService.startTimer();

      // Restore analysis from cache for persisted jobs
      if (hasPersistedFeed && this.selectedResume) {
        this.restoreAnalysisFromCache();
      }
    }
  }

  // ============ Session State Management ============

  private saveSessionState() {
    const state = {
      searchQuery: this.searchQuery,
      searchLocation: this.searchLocation,
      selectedSource: this.selectedSource,
      selectedCandidateId: this.selectedCandidateId,
      selectedResumeId: this.selectedResumeId,
      vendorStatusFilter: this.vendorStatusFilter,
      showVendorSection: this.showVendorSection,
      currentPage: this.currentPage,
      jobs: this.jobs,
      vendorJobs: this.vendorJobs,
      totalJobs: this.totalJobs,
      totalPages: this.totalPages,
      stats: this.stats,
      activeView: this.activeView,
      vendorJobsPage: this.vendorJobsPage,
      vendorJobsTotal: this.vendorJobsTotal,
      vendorJobsTotalPages: this.vendorJobsTotalPages,
      // Unified feed state
      unifiedJobs: this.unifiedJobs,
      sourceFilter: this.sourceFilter,
      sortBy: this.sortBy,
      lastRefreshTime: this.lastRefreshTime?.toISOString() || null
    };
    sessionStorage.setItem(this.SESSION_STATE_KEY, JSON.stringify(state));
  }

  private restoreSessionState() {
    const savedState = sessionStorage.getItem(this.SESSION_STATE_KEY);
    if (savedState) {
      try {
        const state = JSON.parse(savedState);
        this.searchQuery = state.searchQuery || '';
        this.searchLocation = state.searchLocation || '';
        this.selectedSource = state.selectedSource || 'adzuna';
        this.selectedCandidateId = state.selectedCandidateId || '';
        this.selectedResumeId = state.selectedResumeId || '';
        this.vendorStatusFilter = state.vendorStatusFilter || '';
        this.showVendorSection = state.showVendorSection || false;
        this.currentPage = state.currentPage || 1;
        this.jobs = state.jobs || [];
        this.vendorJobs = state.vendorJobs || [];
        this.totalJobs = state.totalJobs || 0;
        this.totalPages = state.totalPages || 0;
        this.stats = state.stats || { totalFound: 0, averageSalary: 0, avgMatchScore: 0 };
        this.activeView = state.activeView || 'search';
        this.vendorJobsPage = state.vendorJobsPage || 1;
        this.vendorJobsTotal = state.vendorJobsTotal || 0;
        this.vendorJobsTotalPages = state.vendorJobsTotalPages || 0;

        // Restore unified feed state
        this.sourceFilter = state.sourceFilter || 'all';
        this.sortBy = state.sortBy || 'date';
        if (state.lastRefreshTime) {
          this.lastRefreshTime = new Date(state.lastRefreshTime);
        }

        // Restore unified jobs and sync to service
        if (state.unifiedJobs?.length > 0) {
          this.unifiedJobs = state.unifiedJobs;
          this.unifiedFeedService.setJobs(state.unifiedJobs);
        }
      } catch (e) {
        console.error('Failed to restore session state:', e);
      }
    }
  }

  private clearSessionState() {
    sessionStorage.removeItem(this.SESSION_STATE_KEY);
  }

  async loadProfile() {
    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.profile = profile;
  }

  async loadCandidates() {
    try {
      this.candidates = await this.supabase.getCandidates();
      // Auto-select first candidate if available
      if (this.candidates.length > 0) {
        this.selectCandidate(this.candidates[0].id);
      }
    } catch (err) {
      console.error('Failed to load candidates:', err);
    }
  }

  get selectedCandidate(): Candidate | null {
    return this.candidates.find(c => c.id === this.selectedCandidateId) || null;
  }

  get selectedResume(): Resume | null {
    const candidate = this.selectedCandidate;
    if (!candidate) return null;
    return candidate.resumes.find(r => r.id === this.selectedResumeId) || null;
  }

  get candidateResumes(): Resume[] {
    return this.selectedCandidate?.resumes || [];
  }

  get filteredCandidates(): Candidate[] {
    if (!this.candidateSearchQuery.trim()) {
      return this.candidates;
    }
    const query = this.candidateSearchQuery.toLowerCase();
    return this.candidates.filter(c =>
      c.name.toLowerCase().includes(query) ||
      (c.current_title && c.current_title.toLowerCase().includes(query))
    );
  }

  openCandidateDrawer() {
    this.showCandidateDrawer = true;
    this.candidateSearchQuery = '';
  }

  closeCandidateDrawer() {
    this.showCandidateDrawer = false;
  }

  selectCandidateFromDrawer(candidateId: string) {
    this.selectCandidate(candidateId);
  }

  selectCandidate(candidateId: string) {
    this.selectedCandidateId = candidateId;
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this.selectedResumeId = primary?.id || candidate.resumes[0].id;
    } else {
      this.selectedResumeId = '';
    }
    // Reset match scores when candidate changes
    this.jobs.forEach(job => {
      job.match_score = undefined;
      job.matching_skills = undefined;
      job.missing_skills = undefined;
      job.analyzed = false;
    });

    // Auto-fill search fields from preferences if enabled
    if (this.usePreferences && candidate) {
      this.fillSearchFromPreferences(candidate);
    }

    // Reload vendor jobs for the new candidate
    this.loadVendorJobs();

    // Check Gmail status for new candidate
    this.checkGmailStatus();

    // Search for jobs based on new candidate's preferences
    if (candidate) {
      this.searchWithPreferences();
    }
  }

  // Fill search fields from candidate preferences
  fillSearchFromPreferences(candidate: Candidate) {
    // Fill job title from preferred titles or current title
    if (candidate.preferences?.preferred_job_titles?.length) {
      this.searchQuery = candidate.preferences.preferred_job_titles[0];
    } else if (candidate.current_title) {
      this.searchQuery = candidate.current_title;
    }

    // Fill location from preferred locations or candidate location
    if (candidate.preferences?.preferred_locations?.length) {
      this.searchLocation = candidate.preferences.preferred_locations[0];
    } else if (candidate.location) {
      this.searchLocation = candidate.location;
    }
  }

  // Search using all preferred job titles
  async searchWithPreferences() {
    const candidate = this.selectedCandidate;
    if (!candidate) return;

    // Get all preferred job titles or fall back to current title
    const titles = candidate.preferences?.preferred_job_titles?.length
      ? candidate.preferences.preferred_job_titles
      : candidate.current_title
        ? [candidate.current_title]
        : [];

    if (titles.length === 0) {
      // No preferences, just do a regular search
      this.searchJobs();
      return;
    }

    // Get location - use "Remote" if remote is preferred and no specific location
    const preferredWorkTypes = candidate.preferences?.preferred_work_type || [];
    const prefersRemote = preferredWorkTypes.includes('remote');

    let location = '';
    if (candidate.preferences?.preferred_locations?.length) {
      location = candidate.preferences.preferred_locations[0];
    } else if (prefersRemote) {
      location = 'Remote';
    } else if (candidate.location) {
      location = candidate.location;
    }

    this.searchLocation = location;
    this.searching = true;
    this.currentPage = 1;
    this.jobs = [];

    try {
      // Search for each preferred job title and combine results
      const allJobs: JobWithMatch[] = [];
      const seenIds = new Set<string>();

      for (const title of titles.slice(0, 3)) { // Limit to first 3 titles
        // Add "remote" to query if that's their preference
        const searchTitle = prefersRemote && !title.toLowerCase().includes('remote')
          ? `${title} remote`
          : title;

        this.searchQuery = title;

        const params: JobSearchParams = {
          query: searchTitle,
          location: location || undefined,
          page: 1,
          resultsPerPage: 10 // Get 10 per title
        };

        let result;
        if (this.selectedSource === 'adzuna') {
          result = await this.jobFeedService.searchAdzunaJobs(params);
        } else if (this.selectedSource === 'rapidapi') {
          result = await this.jobFeedService.searchRapidApiJobs(params);
        } else {
          result = await this.jobFeedService.searchAllJobs(params);
        }

        // Add unique jobs
        for (const job of result.jobs) {
          if (!seenIds.has(job.id)) {
            seenIds.add(job.id);
            allJobs.push({
              ...job,
              match_score: undefined,
              matching_skills: undefined,
              missing_skills: undefined,
              analyzing: false,
              analyzed: false
            });
          }
        }
      }

      this.jobs = allJobs;
      this.totalJobs = allJobs.length;
      this.totalPages = 1;
      this.searchQuery = titles.join(', '); // Show combined titles in search
      this.calculateStats();

      // Auto-analyze if resume is selected
      if (this.selectedResumeId && this.jobs.length > 0) {
        this.analyzeAllJobs();
      }
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  // Check if job matches candidate's work type preference
  checkWorkTypeMatch(job: JobWithMatch): { matches: boolean; reason: string } {
    const candidate = this.selectedCandidate;
    if (!candidate?.preferences?.preferred_work_type?.length) {
      return { matches: true, reason: '' };
    }

    const preferredTypes = candidate.preferences.preferred_work_type;
    const jobLocation = (job.location || '').toLowerCase();
    const jobType = (job.employment_type || '').toLowerCase();
    const jobDescription = (job.description || '').toLowerCase();

    // Check if job is remote
    const isRemote = jobLocation.includes('remote') ||
                     jobType.includes('remote') ||
                     jobDescription.includes('fully remote') ||
                     jobDescription.includes('100% remote');

    // Check if job is hybrid
    const isHybrid = jobLocation.includes('hybrid') ||
                     jobType.includes('hybrid') ||
                     jobDescription.includes('hybrid');

    // Check if job is onsite
    const isOnsite = !isRemote && !isHybrid;

    if (preferredTypes.includes('remote') && isRemote) {
      return { matches: true, reason: 'Remote position matches preference' };
    }
    if (preferredTypes.includes('hybrid') && isHybrid) {
      return { matches: true, reason: 'Hybrid position matches preference' };
    }
    if (preferredTypes.includes('onsite') && isOnsite) {
      return { matches: true, reason: 'Onsite position matches preference' };
    }

    // Check if any preferred type might match
    if (preferredTypes.includes('remote') && !isRemote) {
      return { matches: false, reason: 'Position may not be remote' };
    }

    return { matches: true, reason: '' };
  }

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
    // Reset match scores when resume changes
    this.jobs.forEach(job => {
      job.match_score = undefined;
      job.matching_skills = undefined;
      job.missing_skills = undefined;
      job.analyzed = false;
    });
  }

  // Build search query from candidate preferences
  getPreferenceBasedQuery(): { query: string; location: string } {
    const candidate = this.selectedCandidate;
    const resume = this.selectedResume;

    let query = this.searchQuery;
    let location = this.searchLocation;

    if (this.usePreferences && candidate) {
      // Use preferred job titles or current title
      if (!query && candidate.preferences?.preferred_job_titles?.length) {
        query = candidate.preferences.preferred_job_titles[0];
      } else if (!query && candidate.current_title) {
        query = candidate.current_title;
      }

      // Use preferred locations
      if (!location && candidate.preferences?.preferred_locations?.length) {
        location = candidate.preferences.preferred_locations[0];
      } else if (!location && candidate.location) {
        location = candidate.location;
      }
    }

    return { query, location };
  }

  async searchJobs() {
    const { query, location } = this.getPreferenceBasedQuery();
    if (!query.trim()) return;

    this.searchQuery = query;
    this.searchLocation = location;
    this.searching = true;
    this.searchLoadingText = 'Connecting to job sources...';
    this.currentPage = 1;

    const params: JobSearchParams = {
      query: query,
      location: location || undefined,
      page: this.currentPage,
      resultsPerPage: this.resultsPerPage,
      workType: this.selectedCandidate?.preferences?.preferred_work_type?.[0] as any
    };

    try {
      let result;

      // Update loading text based on source
      this.searchLoadingText = `Searching ${this.getSourceLabel(this.selectedSource)}...`;

      // Determine which search method to use based on selected source
      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else if (this.selectedSource === 'ai-search') {
        // AI search across all platforms
        this.searchLoadingText = 'AI searching multiple platforms...';
        result = await this.jobFeedService.searchWithAI(params, this.aiSearchPlatforms);
      } else if (['dice', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter'].includes(this.selectedSource)) {
        // AI search for specific platform
        result = await this.jobFeedService.searchWithAI(params, [this.selectedSource]);
      } else if (this.selectedSource === 'all') {
        // Search all sources including AI
        this.searchLoadingText = 'Searching all sources...';
        const [adzunaResult, aiResult] = await Promise.all([
          this.jobFeedService.searchAdzunaJobs(params),
          this.jobFeedService.searchWithAI(params, ['dice', 'indeed', 'linkedin'])
        ]);
        // Combine and deduplicate results
        const allJobs = [...adzunaResult.jobs, ...aiResult.jobs];
        const uniqueJobs = this.deduplicateJobs(allJobs);
        result = {
          jobs: uniqueJobs,
          total: adzunaResult.total + aiResult.total,
          page: 1,
          totalPages: 1
        };
      } else {
        result = await this.jobFeedService.searchAllJobs(params);
      }

      this.searchLoadingText = 'Processing results...';

      this.jobs = result.jobs.map(job => ({
        ...job,
        match_score: undefined,
        matching_skills: undefined,
        missing_skills: undefined,
        analyzing: false,
        analyzed: false
      }));
      this.totalJobs = result.total;
      this.totalPages = result.totalPages;
      this.calculateStats();

      // Auto-analyze if candidate is selected
      if (this.selectedResumeId && this.jobs.length > 0) {
        this.analyzeAllJobs();
      }

      // Save session state after successful search
      this.saveSessionState();
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  private getSourceLabel(source: JobPlatform): string {
    const labels: Record<JobPlatform, string> = {
      'adzuna': 'Adzuna',
      'rapidapi': 'JSearch',
      'dice': 'Dice',
      'linkedin': 'LinkedIn',
      'indeed': 'Indeed',
      'glassdoor': 'Glassdoor',
      'ziprecruiter': 'ZipRecruiter',
      'ai-search': 'AI Search',
      'all': 'All Sources'
    };
    return labels[source] || source;
  }

  // Deduplicate jobs by title and company
  private deduplicateJobs(jobs: JobWithMatch[]): JobWithMatch[] {
    const seen = new Set<string>();
    return jobs.filter(job => {
      const key = `${job.title.toLowerCase()}-${job.company.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async loadMore() {
    if (this.currentPage >= this.totalPages || this.loading) return;

    this.loading = true;
    this.currentPage++;

    const params: JobSearchParams = {
      query: this.searchQuery,
      location: this.searchLocation || undefined,
      page: this.currentPage,
      resultsPerPage: this.resultsPerPage
    };

    try {
      let result;
      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else {
        result = await this.jobFeedService.searchAllJobs(params);
      }

      const newJobs = result.jobs.map(job => ({
        ...job,
        match_score: undefined,
        matching_skills: undefined,
        missing_skills: undefined,
        analyzing: false,
        analyzed: false
      }));
      this.jobs = [...this.jobs, ...newJobs];

      // Analyze new jobs
      if (this.selectedResumeId) {
        this.analyzeNewJobs(newJobs);
      }
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      this.loading = false;
    }
  }

  async analyzeAllJobs() {
    if (!this.selectedResume || this.jobs.length === 0) return;

    this.analyzingAll = true;
    this.analyzedCount = 0;

    // Analyze jobs in batches of 3 to avoid rate limiting
    const batchSize = 3;
    for (let i = 0; i < this.jobs.length; i += batchSize) {
      const batch = this.jobs.slice(i, i + batchSize);
      await Promise.all(batch.map(job => this.analyzeJob(job)));
      this.analyzedCount = Math.min(i + batchSize, this.jobs.length);
    }

    this.analyzingAll = false;
    this.calculateStats();
    this.sortJobsByMatch();
  }

  async analyzeNewJobs(jobs: JobWithMatch[]) {
    if (!this.selectedResume) return;

    const batchSize = 3;
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      await Promise.all(batch.map(job => this.analyzeJob(job)));
    }
    this.calculateStats();
  }

  async analyzeJob(job: JobWithMatch) {
    if (!this.selectedResume || job.analyzing || job.analyzed) return;

    job.analyzing = true;

    try {
      // Create a partial job object for analysis
      const jobData = {
        job_title: job.title,
        company_name: job.company,
        location: job.location,
        description_full: job.description,
        required_skills: this.extractSkillsFromDescription(job.description),
        employment_type: job.employment_type,
        salary_min: job.salary_min,
        salary_max: job.salary_max
      };

      const result = await this.supabase.analyzeMatchWithAI(this.selectedResume, jobData);

      job.match_score = result.match_score;
      job.matching_skills = result.matching_skills || [];
      job.missing_skills = result.missing_skills || [];
      job.analyzed = true;
    } catch (err) {
      console.error('Analysis error for job:', job.title, err);
      job.match_score = undefined;
    } finally {
      job.analyzing = false;
    }
  }

  // Simple skill extraction from job description
  extractSkillsFromDescription(description: string): { skill: string; importance: 'Required' | 'Preferred' }[] {
    const commonSkills = [
      'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP',
      'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'Spring', '.NET',
      'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'CI/CD', 'Git', 'Linux',
      'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch',
      'Machine Learning', 'AI', 'Data Science', 'TensorFlow', 'PyTorch',
      'Agile', 'Scrum', 'REST API', 'GraphQL', 'Microservices'
    ];

    const descLower = description.toLowerCase();
    const foundSkills: { skill: string; importance: 'Required' | 'Preferred' }[] = [];

    commonSkills.forEach(skill => {
      if (descLower.includes(skill.toLowerCase())) {
        foundSkills.push({ skill, importance: 'Required' });
      }
    });

    return foundSkills;
  }

  sortJobsByMatch() {
    this.jobs.sort((a, b) => {
      if (a.match_score === undefined && b.match_score === undefined) return 0;
      if (a.match_score === undefined) return 1;
      if (b.match_score === undefined) return -1;
      return b.match_score - a.match_score;
    });
  }

  quickSearch(query: string) {
    this.searchQuery = query;
    this.searchJobs();
  }

  calculateStats() {
    this.stats.totalFound = this.totalJobs;

    const jobsWithSalary = this.jobs.filter(j => j.salary_min || j.salary_max);
    if (jobsWithSalary.length > 0) {
      const totalSalary = jobsWithSalary.reduce((sum, j) => {
        const avg = ((j.salary_min || 0) + (j.salary_max || j.salary_min || 0)) / 2;
        return sum + avg;
      }, 0);
      this.stats.averageSalary = Math.round(totalSalary / jobsWithSalary.length);
    } else {
      this.stats.averageSalary = 0;
    }

    // Calculate average match score
    const jobsWithMatch = this.jobs.filter(j => j.match_score !== undefined);
    if (jobsWithMatch.length > 0) {
      const totalMatch = jobsWithMatch.reduce((sum, j) => sum + (j.match_score || 0), 0);
      this.stats.avgMatchScore = Math.round(totalMatch / jobsWithMatch.length);
    } else {
      this.stats.avgMatchScore = 0;
    }
  }

  selectJob(job: JobWithMatch) {
    this.selectedJob = job;
    // Analyze if not already analyzed
    if (!job.analyzed && this.selectedResumeId) {
      this.analyzeJob(job);
    }
  }

  closeJobPreview() {
    this.selectedJob = null;
  }

  applyToJob(job: ExternalJob) {
    if (job.url) {
      window.open(job.url, '_blank');
    }
  }

  async saveJob(job: JobWithMatch) {
    if (!this.selectedResumeId) {
      alert('Please select a candidate and resume first');
      return;
    }

    try {
      // Create job in database
      const jobData = {
        source_url: job.url,
        platform: job.source,
        job_title: job.title,
        company_name: job.company,
        location: job.location,
        description_full: job.description,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        employment_type: job.employment_type,
        match_score: job.match_score,
        matching_skills: job.matching_skills,
        missing_skills: job.missing_skills,
        status: 'new' as const,
        extraction_status: 'completed' as const
      };

      const savedJob = await this.supabase.createJob(jobData);

      // Create application
      await this.supabase.createApplication({
        job_id: savedJob.id,
        resume_id: this.selectedResumeId,
        status: 'extracted'
      });

      alert('Job saved to your applications!');
    } catch (err: any) {
      console.error('Save job error:', err);
      alert('Failed to save job: ' + err.message);
    }
  }

  getMatchClass(score: number | undefined): string {
    if (score === undefined) return '';
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }

  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  getResumeLabel(resume: Resume): string {
    if (resume.label) return resume.label;
    if (resume.file_name) {
      return resume.file_name.split('.')[0] || 'Resume';
    }
    return 'Resume';
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  truncateDescription(text: string, maxLength: number = 200): string {
    if (!text) return '';
    const stripped = text.replace(/<[^>]*>/g, '');
    if (stripped.length <= maxLength) return stripped;
    return stripped.substring(0, maxLength) + '...';
  }

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  goToResumes() {
    this.router.navigate(['/resumes']);
  }

  goToCandidates() {
    this.router.navigate(['/candidates']);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  // ============ Vendor Jobs Methods ============

  async loadVendorJobStats() {
    try {
      this.vendorJobStats = await this.vendorEmailService.getVendorJobStats();
    } catch (err) {
      console.error('Failed to load vendor job stats:', err);
    }
  }

  async toggleVendorSection() {
    this.showVendorSection = !this.showVendorSection;
    if (this.showVendorSection && this.vendorJobs.length === 0) {
      await this.loadVendorJobs();
    }
    this.saveSessionState();
  }

  toggleGmailPanel() {
    this.showGmailPanel = !this.showGmailPanel;
  }

  switchView(view: 'search' | 'email') {
    this.activeView = view;
    if (view === 'email' && this.vendorJobs.length === 0) {
      this.loadVendorJobs();
    }
    this.saveSessionState();
  }

  async loadVendorJobs() {
    this.loadingVendorJobs = true;
    try {
      // Only load vendor jobs for the selected candidate
      if (!this.selectedCandidateId) {
        this.vendorJobs = [];
        this.vendorJobsTotal = 0;
        this.vendorJobsTotalPages = 0;
        return;
      }

      // First, get total count for pagination
      const allJobs = await this.vendorEmailService.getCandidateVendorJobs(this.selectedCandidateId, {
        status: this.vendorStatusFilter || undefined
      });
      this.vendorJobsTotal = allJobs.length;
      this.vendorJobsTotalPages = Math.ceil(this.vendorJobsTotal / this.vendorJobsPerPage);

      // Ensure current page is valid
      if (this.vendorJobsPage > this.vendorJobsTotalPages && this.vendorJobsTotalPages > 0) {
        this.vendorJobsPage = this.vendorJobsTotalPages;
      }

      // Get paginated results
      const offset = (this.vendorJobsPage - 1) * this.vendorJobsPerPage;
      this.vendorJobs = await this.vendorEmailService.getCandidateVendorJobs(this.selectedCandidateId, {
        status: this.vendorStatusFilter || undefined,
        limit: this.vendorJobsPerPage,
        offset: offset
      });

      // Save session state after loading vendor jobs
      this.saveSessionState();
    } catch (err) {
      console.error('Failed to load vendor jobs:', err);
    } finally {
      this.loadingVendorJobs = false;
    }
  }

  // Vendor Jobs Pagination Methods
  goToVendorJobsPage(page: number) {
    if (page < 1 || page > this.vendorJobsTotalPages || page === this.vendorJobsPage) {
      return;
    }
    this.vendorJobsPage = page;
    this.loadVendorJobs();
  }

  previousVendorJobsPage() {
    if (this.vendorJobsPage > 1) {
      this.goToVendorJobsPage(this.vendorJobsPage - 1);
    }
  }

  nextVendorJobsPage() {
    if (this.vendorJobsPage < this.vendorJobsTotalPages) {
      this.goToVendorJobsPage(this.vendorJobsPage + 1);
    }
  }

  getVendorJobsPageNumbers(): number[] {
    const pages: number[] = [];
    const maxPagesToShow = 5;
    let startPage = Math.max(1, this.vendorJobsPage - Math.floor(maxPagesToShow / 2));
    let endPage = Math.min(this.vendorJobsTotalPages, startPage + maxPagesToShow - 1);

    // Adjust start if we're near the end
    if (endPage - startPage + 1 < maxPagesToShow) {
      startPage = Math.max(1, endPage - maxPagesToShow + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      pages.push(i);
    }
    return pages;
  }

  async filterVendorJobs(status: string) {
    this.vendorStatusFilter = status;
    this.vendorJobsPage = 1; // Reset to first page when filtering
    await this.loadVendorJobs();
    // State is saved in loadVendorJobs
  }

  openAddVendorJobModal() {
    this.showAddVendorJobModal = true;
    this.vendorEmailInput = '';
    this.parseError = '';
  }

  closeAddVendorJobModal() {
    this.showAddVendorJobModal = false;
    this.vendorEmailInput = '';
    this.parseError = '';
  }

  async parseVendorEmail() {
    if (!this.vendorEmailInput.trim()) {
      this.parseError = 'Please paste the vendor email content';
      return;
    }

    this.parsingVendorEmail = true;
    this.parseError = '';

    try {
      const result = await this.vendorEmailService.parseVendorEmail({
        emailBody: this.vendorEmailInput
      });

      if (result.success) {
        // Refresh the vendor jobs list
        await this.loadVendorJobs();
        await this.loadVendorJobStats();
        this.closeAddVendorJobModal();
      }
    } catch (err: any) {
      console.error('Failed to parse vendor email:', err);
      this.parseError = err.message || 'Failed to parse email. Please try again.';
    } finally {
      this.parsingVendorEmail = false;
    }
  }

  selectVendorJob(job: VendorJob) {
    this.selectedVendorJob = job;
  }

  closeVendorJobPreview() {
    this.selectedVendorJob = null;
  }

  async updateVendorJobStatus(job: VendorJob, status: VendorJob['status']) {
    try {
      await this.vendorEmailService.updateVendorJobStatus(job.id, status);
      job.status = status;
      if (status === 'interested') {
        job.is_interested = true;
      }
      await this.loadVendorJobStats();
    } catch (err) {
      console.error('Failed to update job status:', err);
    }
  }

  async deleteVendorJob(job: VendorJob) {
    if (!confirm('Are you sure you want to delete this job?')) return;

    try {
      await this.vendorEmailService.deleteVendorJob(job.id);
      this.vendorJobs = this.vendorJobs.filter(j => j.id !== job.id);
      await this.loadVendorJobStats();
      if (this.selectedVendorJob?.id === job.id) {
        this.selectedVendorJob = null;
      }
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }

  getTechStackTags(techStack: VendorJob['tech_stack']): string[] {
    if (!techStack) return [];
    const tags: string[] = [];
    if (techStack.frontend) tags.push(...techStack.frontend);
    if (techStack.backend) tags.push(...techStack.backend);
    if (techStack.cloud) tags.push(...techStack.cloud);
    if (techStack.other) tags.push(...techStack.other);
    return tags.slice(0, 8);
  }

  formatVendorJobDate(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  getVendorStatusClass(status: string): string {
    return this.vendorEmailService.getStatusClass(status);
  }

  formatEmploymentType(type: string): string {
    return this.vendorEmailService.formatEmploymentType(type);
  }

  formatWorkArrangement(arrangement: string): string {
    return this.vendorEmailService.formatWorkArrangement(arrangement);
  }

  // ============ Gmail Integration Methods ============

  async checkGmailStatus() {
    try {
      // Use candidate-specific Gmail status if a candidate is selected
      if (this.selectedCandidateId) {
        this.gmailStatus = await this.vendorEmailService.getCandidateGmailStatus(this.selectedCandidateId);

        // Also load all Gmail accounts for this candidate
        this.gmailAccounts = await this.vendorEmailService.getCandidateGmailAccounts(this.selectedCandidateId);

        // Check if can add more Gmail accounts
        const limitCheck = await this.vendorEmailService.canAddGmailForCandidate(this.selectedCandidateId);
        this.canAddMoreGmail = limitCheck.canAdd;

        console.log('Gmail Accounts:', {
          primaryEmail: this.gmailStatus.google_email,
          totalAccounts: this.gmailAccounts.length,
          canAddMore: this.canAddMoreGmail,
          accounts: this.gmailAccounts
        });
      } else {
        this.gmailStatus = await this.vendorEmailService.getGmailStatus();
        this.gmailAccounts = [];
        this.canAddMoreGmail = false;
      }

      // Debug logging to help troubleshoot
      console.log('Gmail Status:', {
        connected: this.gmailStatus.connected,
        email: this.gmailStatus.google_email,
        candidateId: this.selectedCandidateId,
        lastSync: this.gmailStatus.last_sync_at,
        emailsCount: this.gmailStatus.emails_synced_count
      });
    } catch (err) {
      console.error('Failed to check Gmail status:', err);
      this.gmailStatus = { connected: false };
      this.gmailAccounts = [];
      this.canAddMoreGmail = false;
    }
  }

  async connectGmail() {
    if (!this.selectedCandidateId) {
      alert('Please select a candidate first');
      return;
    }

    this.gmailConnecting = true;
    try {
      const { authUrl } = await this.vendorEmailService.getGmailAuthUrl(this.selectedCandidateId);
      // Store candidate ID for OAuth callback
      sessionStorage.setItem('gmail_oauth_candidate_id', this.selectedCandidateId);
      // Store state for verification
      localStorage.setItem('gmail_oauth_state', authUrl);
      // Open Gmail OAuth in new window
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch (err: any) {
      console.error('Failed to start Gmail OAuth:', err);
      alert('Failed to connect Gmail: ' + err.message);
    } finally {
      this.gmailConnecting = false;
    }
  }

  handleGmailCallback() {
    // Check URL for OAuth callback params
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');

    if (code && state) {
      this.completeGmailAuth(code, state);
      // Clean up URL
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  async handleGmailConnected() {
    // Check if redirected from Gmail callback after successful OAuth
    const urlParams = new URLSearchParams(window.location.search);
    const gmailParam = urlParams.get('gmail');

    if (gmailParam === 'connected') {
      // Refresh Gmail status and auto-sync
      await this.checkGmailStatus();
      if (this.gmailStatus?.connected) {
        await this.syncGmailEmails();
      }
      // Clean up URL
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  async completeGmailAuth(code: string, state: string) {
    this.gmailConnecting = true;
    try {
      // Get candidateId from sessionStorage (set during connectGmail)
      const candidateId = sessionStorage.getItem('gmail_oauth_candidate_id') || this.selectedCandidateId;

      console.log('Completing Gmail OAuth with candidateId:', candidateId);

      const result = await this.vendorEmailService.completeGmailAuth(code, state, candidateId || undefined);
      if (result.success) {
        this.gmailStatus = {
          connected: true,
          google_email: result.email,
          is_active: true
        };
        // Clean up session storage
        sessionStorage.removeItem('gmail_oauth_candidate_id');
        // Auto-sync after connecting
        await this.syncGmailEmails();
      }
    } catch (err: any) {
      console.error('Failed to complete Gmail OAuth:', err);
      alert('Failed to connect Gmail: ' + err.message);
    } finally {
      this.gmailConnecting = false;
    }
  }

  async disconnectGmail() {
    if (!confirm('Are you sure you want to disconnect your Gmail account?')) return;

    try {
      // Use candidate-specific disconnect if a candidate is selected
      if (this.selectedCandidateId) {
        await this.vendorEmailService.disconnectCandidateGmail(this.selectedCandidateId);
      } else {
        await this.vendorEmailService.disconnectGmail();
      }
      this.gmailStatus = { connected: false };
      this.gmailAccounts = [];
      this.gmailSyncResult = null;
      await this.checkGmailStatus();
    } catch (err: any) {
      console.error('Failed to disconnect Gmail:', err);
      alert('Failed to disconnect: ' + err.message);
    }
  }

  async disconnectSpecificGmail(connectionId: string, email: string) {
    if (!confirm(`Disconnect ${email}?`)) return;

    try {
      const success = await this.vendorEmailService.disconnectGmailConnection(connectionId);
      if (success) {
        // Refresh Gmail status after disconnecting
        await this.checkGmailStatus();
        console.log(`Successfully disconnected ${email}`);
      } else {
        alert('Failed to disconnect Gmail account');
      }
    } catch (err: any) {
      console.error('Failed to disconnect Gmail:', err);
      alert('Failed to disconnect: ' + err.message);
    }
  }

  async syncGmailEmails(syncAll = false) {
    if (!this.gmailStatus.connected) {
      alert('Please connect your Gmail account first');
      return;
    }

    if (syncAll && !confirm('This will sync up to 500 emails from your inbox. This may take several minutes. Continue?')) {
      return;
    }

    this.gmailSyncing = true;
    this.gmailSyncResult = null;

    try {
      // Use candidate-specific sync if a candidate is selected
      const result = this.selectedCandidateId
        ? await this.vendorEmailService.syncCandidateEmails(this.selectedCandidateId, {
            syncType: 'manual',
            maxEmails: syncAll ? 500 : 50,
            syncAll: syncAll
          })
        : await this.vendorEmailService.syncGmailEmails({
            syncType: 'manual',
            maxEmails: syncAll ? 500 : 50,
            syncAll: syncAll
          });

      this.gmailSyncResult = result;

      if (result.success && result.jobsCreated > 0) {
        // Refresh vendor jobs list
        await this.loadVendorJobs();
        await this.loadVendorJobStats();
      }

      // Update Gmail status
      await this.checkGmailStatus();
    } catch (err: any) {
      console.error('Failed to sync Gmail:', err);
      this.gmailSyncResult = {
        success: false,
        emailsFound: 0,
        emailsParsed: 0,
        emailsSkipped: 0,
        jobsCreated: 0,
        errors: [err.message]
      };
    } finally {
      this.gmailSyncing = false;
    }
  }

  toggleGmailSettings() {
    this.showGmailSettings = !this.showGmailSettings;
  }

  formatLastSync(dateStr: string | undefined): string {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }

  // ============ Unified Feed & Auto-Refresh Methods ============

  ngOnDestroy() {
    // Save state before destroying to preserve data on navigation
    this.saveSessionState();
    this.unifiedFeedService.saveState();

    this.destroy$.next();
    this.destroy$.complete();
    this.autoRefreshService.stopTimer();
  }

  private setupUnifiedFeedSubscriptions() {
    // Subscribe to unified feed jobs
    this.unifiedFeedService.jobs$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jobs => {
        this.unifiedJobs = this.applySourceFilter(jobs);
        this.applySorting();
      });

    // Subscribe to new jobs count
    this.unifiedFeedService.newJobsCount$
      .pipe(takeUntil(this.destroy$))
      .subscribe(count => {
        this.newJobsCount = count;
      });

    // Subscribe to auto-refresh state
    this.autoRefreshService.state$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.isRefreshing = state.isRefreshing;
        this.lastRefreshTime = state.lastRefreshTime;
        this.autoRefreshPaused = state.isPaused;
        this.refreshCountdown = this.formatCountdown(state.secondsUntilRefresh);
      });

    // Subscribe to refresh triggers
    this.autoRefreshService.refreshTrigger$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.performUnifiedRefresh();
      });

    // Subscribe to analysis progress
    this.analysisQueueService.progress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(progress => {
        this.analysisInProgress = progress.isProcessing;
        this.analysisProgress = progress.progress;
        this.totalToAnalyze = progress.totalJobs;
        this.analyzedCount = progress.analyzedCount;
      });
  }

  async performUnifiedRefresh() {
    if (this.isRefreshing) return;

    this.autoRefreshService.setRefreshing(true);

    try {
      // Build preferences from candidate if available
      const preferences = this.selectedCandidate?.preferences || null;

      // Refresh both API jobs and email jobs
      await this.unifiedFeedService.refreshFeed(preferences, {
        maxJobsPerSource: 50,
        syncGmail: true
      });

      // Start analysis queue if resume is selected
      if (this.selectedResume) {
        const unanalyzedJobs = this.unifiedFeedService.getState().jobs
          .filter(j => !j.analyzed && !j.analyzing)
          .map(j => j.id);

        if (unanalyzedJobs.length > 0) {
          this.analysisQueueService.addToQueue(unanalyzedJobs);
          this.analysisQueueService.processQueue(this.selectedResume);
        }
      }
    } catch (error) {
      console.error('Refresh error:', error);
    } finally {
      this.autoRefreshService.setRefreshing(false);
    }
  }

  manualRefresh() {
    // Directly call performUnifiedRefresh to ensure it works
    this.performUnifiedRefresh();
  }

  toggleAutoRefresh() {
    if (this.autoRefreshPaused) {
      this.autoRefreshService.resume();
    } else {
      this.autoRefreshService.pause();
    }
  }

  clearAllCaches() {
    if (!confirm('This will clear all cached job data and analysis results. You will need to refresh to get jobs again. Continue?')) {
      return;
    }

    // Clear unified feed state
    this.unifiedFeedService.clearState();

    // Clear analysis cache
    this.analysisQueueService.clearCache();

    // Clear local state
    this.unifiedJobs = [];
    this.jobs = [];
    this.newJobsCount = 0;

    console.log('All caches cleared successfully');
    alert('Cache cleared! Click "Refresh Now" to fetch fresh jobs.');
  }

  filterBySource(source: 'all' | 'api' | 'email') {
    this.sourceFilter = source;
    this.unifiedJobs = this.applySourceFilter(this.unifiedFeedService.getState().jobs);
    this.applySorting();
  }

  private applySourceFilter(jobs: UnifiedJob[]): UnifiedJob[] {
    if (this.sourceFilter === 'all') {
      return jobs;
    }
    return jobs.filter(job => job.source_type === this.sourceFilter);
  }

  sortJobsBy(sortBy: 'date' | 'match' | 'salary') {
    this.sortBy = sortBy;
    this.applySorting();
  }

  private applySorting() {
    const jobs = [...this.unifiedJobs];

    switch (this.sortBy) {
      case 'date':
        jobs.sort((a, b) => {
          const dateA = new Date(a.discovered_at || a.posted_date || 0).getTime();
          const dateB = new Date(b.discovered_at || b.posted_date || 0).getTime();
          return dateB - dateA;
        });
        break;
      case 'match':
        jobs.sort((a, b) => {
          const scoreA = a.match_score ?? -1;
          const scoreB = b.match_score ?? -1;
          return scoreB - scoreA;
        });
        break;
      case 'salary':
        jobs.sort((a, b) => {
          const salaryA = a.salary_max || a.salary_min || 0;
          const salaryB = b.salary_max || b.salary_min || 0;
          return salaryB - salaryA;
        });
        break;
    }

    this.unifiedJobs = jobs;
  }

  scrollToNewJobs() {
    // Find first new job and scroll to it
    const newJobElement = document.querySelector('.job-card.is-new');
    if (newJobElement) {
      newJobElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Mark all as seen after scrolling
    this.unifiedFeedService.markAllAsSeen();
  }

  markUnifiedJobAsSeen(jobId: string) {
    this.unifiedFeedService.markAsSeen(jobId);
  }

  private formatCountdown(seconds: number): string {
    if (seconds <= 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Open job URL in new tab
  openJobUrl(url: string) {
    if (url) {
      window.open(url, '_blank');
    }
  }

  // Start the unified feed when candidate is selected
  async startUnifiedFeed() {
    if (!this.selectedCandidate) return;

    // Setup subscriptions if not already done
    this.setupUnifiedFeedSubscriptions();

    // Start auto-refresh timer
    this.autoRefreshService.startTimer();

    // Perform initial refresh
    await this.performUnifiedRefresh();
  }

  // Handle resume change - invalidate analysis cache
  onResumeChangeForUnifiedFeed() {
    if (this.selectedResume) {
      // Clear the analysis cache for previous resume
      this.analysisQueueService.clearQueue();

      // Re-analyze all jobs with new resume
      const jobIds = this.unifiedFeedService.getState().jobs.map(j => j.id);
      this.analysisQueueService.addToQueue(jobIds);
      this.analysisQueueService.processQueue(this.selectedResume);
    }
  }

  // Restore analysis results from cache for persisted jobs
  private restoreAnalysisFromCache() {
    if (!this.selectedResume) return;

    const jobs = this.unifiedFeedService.getState().jobs;
    const jobsToAnalyze: string[] = [];

    for (const job of jobs) {
      // Check if analysis is cached
      const cached = this.analysisQueueService.getCachedAnalysis(
        job.id,
        this.selectedResume.id
      );

      if (cached) {
        // Restore from cache
        this.unifiedFeedService.updateJobAnalysis(job.id, cached.result);
      } else if (!job.analyzed && !job.analyzing) {
        // Queue for analysis
        jobsToAnalyze.push(job.id);
      }
    }

    // Process any queued jobs
    if (jobsToAnalyze.length > 0) {
      this.analysisQueueService.addToQueue(jobsToAnalyze);
      this.analysisQueueService.processQueue(this.selectedResume);
    }
  }
}
