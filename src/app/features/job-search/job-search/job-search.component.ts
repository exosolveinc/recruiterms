import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Candidate, Profile, Resume } from '../../../core/models';
import { AnalysisQueueService } from '../../../core/services/analysis-queue.service';
import { ExternalJob, JobFeedService, JobPlatform, JobSearchParams } from '../../../core/services/job-feed.service';
import { AppStateService } from '../../../core/services/app-state.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { GmailConnectionStatus, GmailSyncResult, VendorEmailService, VendorJob, VendorJobStats } from '../../../core/services/vendor-email.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { SliderModule } from 'primeng/slider';
import { TableModule, Table } from 'primeng/table';

interface JobWithMatch extends ExternalJob {
  match_score?: number;
  matching_skills?: string[];
  missing_skills?: string[];
  analyzing?: boolean;
  analyzed?: boolean;
}

@Component({
  selector: 'app-job-search',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, SidebarComponent, SliderModule, TableModule],
  templateUrl: './job-search.component.html',
  styleUrl: './job-search.component.scss'
})
export class JobSearchComponent implements OnInit, OnDestroy {
  Math = Math;
  private destroy$ = new Subject<void>();

  profile: Profile | null = null;
  jobs: JobWithMatch[] = [];
  loading = false;
  searching = false;

  // Analysis Progress
  analysisInProgress = false;
  analysisProgress = 0;
  totalToAnalyze = 0;

  // Realtime analysis session
  private analysisSessionId: string | null = null;
  private realtimeChannel: any = null;

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
  gmailAccounts: any[] = [];
  canAddMoreGmail = false;
  gmailConnecting = false;
  gmailSyncing = false;
  gmailSyncResult: GmailSyncResult | null = null;
  showGmailSettings = false;
  showGmailPanel = false;

  // View Toggle
  activeView: 'search' | 'email' = 'search';

  // PrimeNG Table State
  @ViewChild('searchTable') searchTable!: Table;
  expandedRows: { [key: string]: boolean } = {};
  tableSortField = '';
  tableSortOrder = 0;
  tableSearchTerm = '';

  // Source column filter
  showSourceFilter = false;
  sourceColumnFilter = 'All';
  availableSources = ['All', 'Adzuna', 'RapidAPI', 'Dice', 'LinkedIn', 'Indeed', 'Glassdoor'];

  // Salary column filter
  salaryRange: number[] = [0, 300000];
  salaryFilterActive = false;

  constructor(
    private supabase: SupabaseService,
    private jobFeedService: JobFeedService,
    private vendorEmailService: VendorEmailService,
    private analysisQueueService: AnalysisQueueService,
    private appState: AppStateService,
    private router: Router
  ) {}

  async ngOnInit() {
    // Subscribe to analysis progress
    this.analysisQueueService.progress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(progress => {
        this.analysisInProgress = progress.isProcessing;
        this.analysisProgress = progress.progress;
        this.totalToAnalyze = progress.totalJobs;
        this.analyzedCount = progress.analyzedCount;
      });

    await this.loadProfile();
    await this.loadCandidates();

    // After loadCandidates sets selectedResumeId, load jobs from DB
    if (this.selectedResumeId) {
      await this.loadJobsFromDB();
    }

    await this.loadVendorJobStats();
    await this.checkGmailStatus();

    this.handleGmailCallback();
    this.handleGmailConnected();
  }

  ngOnDestroy() {
    this.cleanupRealtimeChannel();
    this.destroy$.next();
    this.destroy$.complete();
  }

  private async loadJobsFromDB() {
    if (!this.selectedResumeId) return;
    try {
      const dbResults = await this.supabase.getSearchResultsByResume(this.selectedResumeId);
      if (dbResults.length === 0) return;

      // Reconstruct jobs from stored job_data
      this.jobs = dbResults
        .filter((r: any) => r.job_data)
        .map((r: any) => ({
          ...r.job_data,
          match_score: r.status === 'completed' ? r.match_score : undefined,
          matching_skills: r.status === 'completed' ? (r.matching_skills || []) : undefined,
          missing_skills: r.status === 'completed' ? (r.missing_skills || []) : undefined,
          analyzed: r.status === 'completed',
          analyzing: r.status === 'pending'
        }));

      this.totalJobs = this.jobs.length;
      this.totalPages = 1;
      this.calculateStats();

      // Re-subscribe to pending analyses
      const pending = this.jobs.filter((j: any) => j.analyzing);
      if (pending.length > 0) {
        const pendingResult = dbResults.find((r: any) => r.status === 'pending');
        if (pendingResult?.session_id) {
          this.analysisSessionId = pendingResult.session_id;
          this.analysisInProgress = true;
          this.totalToAnalyze = pending.length;
          this.analyzedCount = 0;

          this.realtimeChannel = this.supabase.subscribeToSearchResults(
            pendingResult.session_id,
            (payload: any) => this.handleRealtimeUpdate(payload)
          );
        }
      }
    } catch (e) {
      console.error('Failed to load jobs from DB:', e);
    }
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
      if (this.appState.candidatesLoaded()) {
        this.candidates = this.appState.candidates();
      } else {
        this.candidates = await this.supabase.getCandidates();
        this.appState.setCandidates(this.candidates);
      }
      if (this.candidates.length > 0 && !this.selectedCandidateId) {
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
    // Invalidate cached analysis for the old resume before switching
    if (this.selectedResumeId) {
      this.analysisQueueService.invalidateForResume(this.selectedResumeId);
    }

    // Cleanup realtime channel from previous candidate
    this.cleanupRealtimeChannel();

    this.selectedCandidateId = candidateId;
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this.selectedResumeId = primary?.id || candidate.resumes[0].id;
    } else {
      this.selectedResumeId = '';
    }

    // Clear current state and load from DB
    this.jobs = [];
    this.totalJobs = 0;
    this.totalPages = 0;
    this.currentPage = 1;
    this.stats = { totalFound: 0, averageSalary: 0, avgMatchScore: 0 };

    // Load this candidate's jobs from DB
    if (this.selectedResumeId) {
      this.loadJobsFromDB();
    }

    // Auto-fill search fields from preferences if enabled
    if (this.usePreferences && candidate) {
      this.fillSearchFromPreferences(candidate);
    }

    // Reload vendor jobs for the new candidate
    this.loadVendorJobs();

    // Check Gmail status for new candidate
    this.checkGmailStatus();
  }

  fillSearchFromPreferences(candidate: Candidate) {
    if (candidate.preferences?.preferred_job_titles?.length) {
      this.searchQuery = candidate.preferences.preferred_job_titles[0];
    } else if (candidate.current_title) {
      this.searchQuery = candidate.current_title;
    }

    if (candidate.preferences?.preferred_locations?.length) {
      this.searchLocation = candidate.preferences.preferred_locations[0];
    } else if (candidate.location) {
      this.searchLocation = candidate.location;
    }
  }

  async searchWithPreferences() {
    const candidate = this.selectedCandidate;
    if (!candidate) return;

    const titles = candidate.preferences?.preferred_job_titles?.length
      ? candidate.preferences.preferred_job_titles
      : candidate.current_title
        ? [candidate.current_title]
        : [];

    if (titles.length === 0) {
      this.searchJobs();
      return;
    }

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
      const allJobs: JobWithMatch[] = [];
      const seenIds = new Set<string>();

      for (const title of titles.slice(0, 3)) {
        const searchTitle = prefersRemote && !title.toLowerCase().includes('remote')
          ? `${title} remote`
          : title;

        this.searchQuery = title;

        const params: JobSearchParams = {
          query: searchTitle,
          location: location || undefined,
          page: 1,
          resultsPerPage: 10
        };

        let result;
        if (this.selectedSource === 'adzuna') {
          result = await this.jobFeedService.searchAdzunaJobs(params);
        } else if (this.selectedSource === 'rapidapi') {
          result = await this.jobFeedService.searchRapidApiJobs(params);
        } else {
          result = await this.jobFeedService.searchAllJobs(params);
        }

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
      this.searchQuery = titles.join(', ');
      this.calculateStats();
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  checkWorkTypeMatch(job: JobWithMatch): { matches: boolean; reason: string } {
    const candidate = this.selectedCandidate;
    if (!candidate?.preferences?.preferred_work_type?.length) {
      return { matches: true, reason: '' };
    }

    const preferredTypes = candidate.preferences.preferred_work_type;
    const jobLocation = (job.location || '').toLowerCase();
    const jobType = (job.employment_type || '').toLowerCase();
    const jobDescription = (job.description || '').toLowerCase();

    const isRemote = jobLocation.includes('remote') ||
                     jobType.includes('remote') ||
                     jobDescription.includes('fully remote') ||
                     jobDescription.includes('100% remote');

    const isHybrid = jobLocation.includes('hybrid') ||
                     jobType.includes('hybrid') ||
                     jobDescription.includes('hybrid');

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

    if (preferredTypes.includes('remote') && !isRemote) {
      return { matches: false, reason: 'Position may not be remote' };
    }

    return { matches: true, reason: '' };
  }

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
    this.jobs.forEach(job => {
      job.match_score = undefined;
      job.matching_skills = undefined;
      job.missing_skills = undefined;
      job.analyzed = false;
    });
  }

  getPreferenceBasedQuery(): { query: string; location: string } {
    const candidate = this.selectedCandidate;

    let query = this.searchQuery;
    let location = this.searchLocation;

    if (this.usePreferences && candidate) {
      if (!query && candidate.preferences?.preferred_job_titles?.length) {
        query = candidate.preferences.preferred_job_titles[0];
      } else if (!query && candidate.current_title) {
        query = candidate.current_title;
      }

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

      this.searchLoadingText = `Searching ${this.getSourceLabel(this.selectedSource)}...`;

      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else if (this.selectedSource === 'ai-search') {
        this.searchLoadingText = 'AI searching multiple platforms...';
        result = await this.jobFeedService.searchWithAI(params, this.aiSearchPlatforms);
      } else if (['dice', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter'].includes(this.selectedSource)) {
        result = await this.jobFeedService.searchWithAI(params, [this.selectedSource]);
      } else if (this.selectedSource === 'all') {
        this.searchLoadingText = 'Searching all sources...';
        const [adzunaResult, aiResult] = await Promise.all([
          this.jobFeedService.searchAdzunaJobs(params),
          this.jobFeedService.searchWithAI(params, ['dice', 'indeed', 'linkedin'])
        ]);
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

      // Start passive background analysis
      if (this.selectedResumeId && this.jobs.length > 0) {
        this.startBackgroundAnalysis();
      }
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
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      this.loading = false;
    }
  }

  async startBackgroundAnalysis() {
    if (!this.selectedResume || this.jobs.length === 0) return;

    // Unsubscribe from previous session
    this.cleanupRealtimeChannel();

    const sessionId = crypto.randomUUID();
    this.analysisSessionId = sessionId;

    // Restore any completed results from DB before determining what needs analysis
    try {
      const dbResults = await this.supabase.getSearchResultsByResume(this.selectedResumeId);
      const resultsMap = new Map(dbResults.map(r => [r.external_job_id, r]));

      for (const job of this.jobs) {
        if (!job.analyzed && !job.analyzing) {
          const result = resultsMap.get(job.id);
          if (result) {
            job.match_score = result.match_score;
            job.matching_skills = result.matching_skills || [];
            job.missing_skills = result.missing_skills || [];
            job.analyzed = true;
          }
        }
      }
    } catch (e) {
      console.error('Failed to check DB for existing analysis:', e);
    }

    const unanalyzed = this.jobs.filter(j => !j.analyzed && !j.analyzing);
    if (unanalyzed.length === 0) return;

    this.analysisInProgress = true;
    this.totalToAnalyze = unanalyzed.length;
    this.analyzedCount = 0;
    this.analysisProgress = 0;

    // Mark all jobs as analyzing
    unanalyzed.forEach(j => j.analyzing = true);

    try {
      // Insert pending rows in DB (with full job data for persistence)
      await this.supabase.insertPendingSearchResults(
        sessionId,
        this.selectedResumeId,
        unanalyzed.map(j => ({
          id: j.id,
          title: j.title,
          company: j.company,
          jobData: {
            id: j.id, title: j.title, company: j.company,
            location: j.location, description: j.description,
            salary_min: j.salary_min, salary_max: j.salary_max,
            salary_text: j.salary_text, url: j.url,
            posted_date: j.posted_date, source: j.source,
            employment_type: j.employment_type, category: j.category,
            work_type: j.work_type, experience_level: j.experience_level,
            required_skills: j.required_skills
          }
        }))
      );

      // Subscribe to Realtime updates
      this.realtimeChannel = this.supabase.subscribeToSearchResults(
        sessionId,
        (payload: any) => this.handleRealtimeUpdate(payload)
      );

      // Fire-and-forget: start the edge function
      this.supabase.startBatchAnalysis(
        sessionId,
        this.selectedResume!,
        unanalyzed.map(j => ({
          external_job_id: j.id,
          job_title: j.title,
          company_name: j.company,
          location: j.location,
          description: j.description
        }))
      );
    } catch (err) {
      console.error('Failed to start background analysis:', err);
      this.analysisInProgress = false;
      unanalyzed.forEach(j => j.analyzing = false);
    }
  }

  private handleRealtimeUpdate(payload: any) {
    const row = payload.new;
    if (!row) return;

    const job = this.jobs.find(j => j.id === row.external_job_id);
    if (!job) return;

    if (row.status === 'completed') {
      job.match_score = row.match_score;
      job.matching_skills = row.matching_skills || [];
      job.missing_skills = row.missing_skills || [];
      job.analyzed = true;
      job.analyzing = false;
    } else if (row.status === 'error') {
      job.analyzing = false;
    }

    // Update progress
    this.analyzedCount = this.jobs.filter(j => j.analyzed || (!j.analyzing && j.match_score === undefined && this.analysisInProgress === false)).length;
    const completedOrErrored = this.jobs.filter(j => j.analyzed || (row.status === 'error' && j.id === row.external_job_id)).length;
    this.analyzedCount = this.jobs.filter(j => j.analyzed).length;
    const processedCount = this.jobs.filter(j => j.analyzed || (!j.analyzing && j.match_score === undefined)).length;

    // Recalculate based on how many are done
    const totalAnalyzing = this.jobs.filter(j => j.analyzing).length;
    const totalDone = this.jobs.filter(j => j.analyzed).length;
    const totalErrored = this.totalToAnalyze - totalAnalyzing - totalDone;

    this.analyzedCount = totalDone;
    this.analysisProgress = this.totalToAnalyze > 0
      ? Math.round(((totalDone + totalErrored) / this.totalToAnalyze) * 100)
      : 0;

    this.calculateStats();

    // All jobs processed
    if (totalAnalyzing === 0 && this.analysisInProgress) {
      this.analysisInProgress = false;
      this.cleanupRealtimeChannel();
    }
  }

  private cleanupRealtimeChannel() {
    if (this.realtimeChannel) {
      this.supabase.supabaseClient.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    this.analysisSessionId = null;
  }

  async analyzeJob(job: JobWithMatch) {
    if (!this.selectedResume || job.analyzing || job.analyzed) return;

    job.analyzing = true;

    try {
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

    const jobsWithMatch = this.jobs.filter(j => j.match_score !== undefined);
    if (jobsWithMatch.length > 0) {
      const totalMatch = jobsWithMatch.reduce((sum, j) => sum + (j.match_score || 0), 0);
      this.stats.avgMatchScore = Math.round(totalMatch / jobsWithMatch.length);
    } else {
      this.stats.avgMatchScore = 0;
    }
  }

  // ============ PrimeNG Table Methods ============

  onTableSort(event: Event, field: string) {
    if (this.tableSortField === field) {
      this.tableSortOrder = this.tableSortOrder === 1 ? -1 : 0;
    } else {
      this.tableSortField = field;
      this.tableSortOrder = 1;
    }

    if (this.tableSortOrder !== 0) {
      this.searchTable.sortField = this.tableSortField;
      this.searchTable.sortOrder = this.tableSortOrder;
      this.searchTable.sortSingle();
    } else {
      this.searchTable.sortField = '';
      this.searchTable.sortOrder = 0;
      this.searchTable.reset();
    }
  }

  getTableSortIcon(field: string): string {
    if (this.tableSortField !== field || this.tableSortOrder === 0) return 'pi-sort-alt';
    return this.tableSortOrder === 1 ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down';
  }

  onTableFilter(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.searchTable.filterGlobal(value, 'contains');
  }

  @HostListener('document:click')
  onDocumentClick() {
    this.showSourceFilter = false;
  }

  toggleSourceFilter(event: Event) {
    event.stopPropagation();
    this.showSourceFilter = !this.showSourceFilter;
  }

  filterBySource2(source: string) {
    this.sourceColumnFilter = source;
    this.showSourceFilter = false;
    if (source === 'All') {
      this.searchTable.filter('', 'source', 'contains');
    } else {
      this.searchTable.filter(source.toLowerCase(), 'source', 'contains');
    }
  }

  // Salary filter
  get filteredJobs(): JobWithMatch[] {
    if (!this.salaryFilterActive) return this.jobs;
    return this.jobs.filter(job => {
      const salary = job.salary_max ?? job.salary_min;
      if (salary === null || salary === undefined) return this.salaryRange[0] === 0;
      return salary >= this.salaryRange[0] && salary <= this.salaryRange[1];
    });
  }

  hasSalaryFilter(): boolean {
    return this.salaryFilterActive;
  }

  onSalaryFilterChange() {
    this.salaryFilterActive = true;
  }

  clearSalaryFilter() {
    this.salaryRange = [0, 300000];
    this.salaryFilterActive = false;
  }

  formatSalaryK(value: number): string {
    return '$' + (value / 1000).toFixed(0) + 'k';
  }

  selectJob(job: JobWithMatch) {
    this.selectedJob = job;
    // Analysis is handled by the realtime background flow — no on-click analysis call
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

  formatSalaryRange(job: any): string {
    if (job.salary_text) return job.salary_text;
    if (job.salary_min && job.salary_max) {
      return `$${job.salary_min.toLocaleString()} - $${job.salary_max.toLocaleString()}`;
    }
    if (job.salary_min) return `$${job.salary_min.toLocaleString()}+`;
    if (job.salary_max) return `Up to $${job.salary_max.toLocaleString()}`;
    return '—';
  }

  goToCandidates() {
    this.router.navigate(['/candidates']);
  }

  // ============ Vendor Jobs Methods ============

  async loadVendorJobStats() {
    try {
      this.vendorJobStats = await this.vendorEmailService.getVendorJobStats();
    } catch (err) {
      console.error('Failed to load vendor job stats:', err);
    }
  }

  toggleGmailPanel() {
    this.showGmailPanel = !this.showGmailPanel;
  }

  switchView(view: 'search' | 'email') {
    this.activeView = view;
    if (view === 'email' && this.vendorJobs.length === 0) {
      this.loadVendorJobs();
    }
  }

  async loadVendorJobs() {
    this.loadingVendorJobs = true;
    try {
      if (!this.selectedCandidateId) {
        this.vendorJobs = [];
        this.vendorJobsTotal = 0;
        this.vendorJobsTotalPages = 0;
        return;
      }

      const allJobs = await this.vendorEmailService.getCandidateVendorJobs(this.selectedCandidateId, {
        status: this.vendorStatusFilter || undefined
      });
      this.vendorJobsTotal = allJobs.length;
      this.vendorJobsTotalPages = Math.ceil(this.vendorJobsTotal / this.vendorJobsPerPage);

      if (this.vendorJobsPage > this.vendorJobsTotalPages && this.vendorJobsTotalPages > 0) {
        this.vendorJobsPage = this.vendorJobsTotalPages;
      }

      const offset = (this.vendorJobsPage - 1) * this.vendorJobsPerPage;
      this.vendorJobs = await this.vendorEmailService.getCandidateVendorJobs(this.selectedCandidateId, {
        status: this.vendorStatusFilter || undefined,
        limit: this.vendorJobsPerPage,
        offset: offset
      });
    } catch (err) {
      console.error('Failed to load vendor jobs:', err);
    } finally {
      this.loadingVendorJobs = false;
    }
  }

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
    this.vendorJobsPage = 1;
    await this.loadVendorJobs();
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
      if (this.selectedCandidateId) {
        this.gmailStatus = await this.vendorEmailService.getCandidateGmailStatus(this.selectedCandidateId);
        this.gmailAccounts = await this.vendorEmailService.getCandidateGmailAccounts(this.selectedCandidateId);
        const limitCheck = await this.vendorEmailService.canAddGmailForCandidate(this.selectedCandidateId);
        this.canAddMoreGmail = limitCheck.canAdd;
      } else {
        this.gmailStatus = await this.vendorEmailService.getGmailStatus();
        this.gmailAccounts = [];
        this.canAddMoreGmail = false;
      }
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
      sessionStorage.setItem('gmail_oauth_candidate_id', this.selectedCandidateId);
      localStorage.setItem('gmail_oauth_state', authUrl);
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch (err: any) {
      console.error('Failed to start Gmail OAuth:', err);
      alert('Failed to connect Gmail: ' + err.message);
    } finally {
      this.gmailConnecting = false;
    }
  }

  handleGmailCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');

    if (code && state) {
      this.completeGmailAuth(code, state);
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  async handleGmailConnected() {
    const urlParams = new URLSearchParams(window.location.search);
    const gmailParam = urlParams.get('gmail');

    if (gmailParam === 'connected') {
      await this.checkGmailStatus();
      if (this.gmailStatus?.connected) {
        await this.syncGmailEmails();
      }
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  async completeGmailAuth(code: string, state: string) {
    this.gmailConnecting = true;
    try {
      const candidateId = sessionStorage.getItem('gmail_oauth_candidate_id') || this.selectedCandidateId;

      const result = await this.vendorEmailService.completeGmailAuth(code, state, candidateId || undefined);
      if (result.success) {
        this.gmailStatus = {
          connected: true,
          google_email: result.email,
          is_active: true
        };
        sessionStorage.removeItem('gmail_oauth_candidate_id');
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
        await this.checkGmailStatus();
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
        await this.loadVendorJobs();
        await this.loadVendorJobStats();
      }

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
}
