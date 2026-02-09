import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Candidate, Profile, Resume, UnifiedJob } from '../../../core/models';
import { AnalysisQueueService } from '../../../core/services/analysis-queue.service';
import { AutoRefreshService } from '../../../core/services/auto-refresh.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { UnifiedFeedService } from '../../../core/services/unified-feed.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { SliderModule } from 'primeng/slider';
import { TableModule, Table } from 'primeng/table';

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, SidebarComponent, SliderModule, TableModule],
  templateUrl: './job-feed.component.html',
  styleUrl: './job-feed.component.scss'
})
export class JobFeedComponent implements OnInit, OnDestroy {
  Math = Math;
  private destroy$ = new Subject<void>();

  profile: Profile | null = null;

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
  analyzedCount = 0;

  // Candidates & Resumes
  candidates: Candidate[] = [];
  selectedCandidateId = '';
  selectedResumeId = '';
  showCandidateDrawer = false;
  candidateSearchQuery = '';

  // PrimeNG Table State
  @ViewChild('unifiedTable') unifiedTable!: Table;

  // Unified feed table state
  expandedUnifiedRows: { [key: string]: boolean } = {};
  unifiedSortField = '';
  unifiedSortOrder = 0;
  unifiedTableSearchTerm = '';

  // Platform column filter
  showPlatformFilter = false;
  platformFilter = 'All';
  availablePlatforms = ['All', 'RapidAPI', 'LinkedIn', 'Indeed', 'Adzuna', 'Gmail', 'Dice', 'Glassdoor'];

  // Salary column filter
  salaryRange: number[] = [0, 300000];
  salaryFilterActive = false;

  // Session state key
  private readonly SESSION_STATE_KEY = 'jobFeed_sessionState';

  constructor(
    private supabase: SupabaseService,
    private autoRefreshService: AutoRefreshService,
    private unifiedFeedService: UnifiedFeedService,
    private analysisQueueService: AnalysisQueueService,
    private router: Router
  ) {}

  async ngOnInit() {
    this.restoreSessionState();

    // Setup unified feed subscriptions early
    this.setupUnifiedFeedSubscriptions();

    // Try to load persisted unified feed state from localStorage
    const hasPersistedFeed = this.unifiedFeedService.loadState();

    await this.loadProfile();
    await this.loadCandidates();

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
      selectedCandidateId: this.selectedCandidateId,
      selectedResumeId: this.selectedResumeId,
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
        this.selectedCandidateId = state.selectedCandidateId || '';
        this.selectedResumeId = state.selectedResumeId || '';

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
      if (this.candidates.length > 0) {
        // If we already have a selected candidate from session state, just ensure resume is set
        if (this.selectedCandidateId && this.candidates.find(c => c.id === this.selectedCandidateId)) {
          const candidate = this.candidates.find(c => c.id === this.selectedCandidateId)!;
          if (!this.selectedResumeId && candidate.resumes.length > 0) {
            const primary = candidate.resumes.find(r => r.is_primary);
            this.selectedResumeId = primary?.id || candidate.resumes[0].id;
          }
        } else {
          this.selectCandidate(this.candidates[0].id);
        }
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
    if (this.selectedCandidateId === candidateId) return;

    this.selectedCandidateId = candidateId;
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this.selectedResumeId = primary?.id || candidate.resumes[0].id;
    } else {
      this.selectedResumeId = '';
    }

    // Refresh the feed and re-analyze for the new candidate
    this.performUnifiedRefresh();
  }

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
    this.onResumeChangeForUnifiedFeed();
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

  goToCandidates() {
    this.router.navigate(['/candidates']);
  }

  // ============ PrimeNG Table Methods ============

  onUnifiedSort(event: Event, field: string) {
    if (this.unifiedSortField === field) {
      this.unifiedSortOrder = this.unifiedSortOrder === 1 ? -1 : 0;
    } else {
      this.unifiedSortField = field;
      this.unifiedSortOrder = 1;
    }

    if (this.unifiedSortOrder !== 0) {
      this.unifiedTable.sortField = this.unifiedSortField;
      this.unifiedTable.sortOrder = this.unifiedSortOrder;
      this.unifiedTable.sortSingle();
    } else {
      this.unifiedTable.sortField = '';
      this.unifiedTable.sortOrder = 0;
      this.unifiedTable.reset();
    }
  }

  getUnifiedSortIcon(field: string): string {
    if (this.unifiedSortField !== field || this.unifiedSortOrder === 0) return 'pi-sort-alt';
    return this.unifiedSortOrder === 1 ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down';
  }

  onUnifiedTableFilter(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.unifiedTable.filterGlobal(value, 'contains');
  }

  clearUnifiedTableFilters() {
    this.unifiedTable.clear();
    this.unifiedTableSearchTerm = '';
    this.unifiedSortField = '';
    this.unifiedSortOrder = 0;
    this.platformFilter = 'All';
    this.salaryRange = [0, 300000];
    this.salaryFilterActive = false;
  }

  @HostListener('document:click')
  onDocumentClick() {
    this.showPlatformFilter = false;
  }

  togglePlatformFilter(event: Event) {
    event.stopPropagation();
    this.showPlatformFilter = !this.showPlatformFilter;
  }

  filterByPlatform(platform: string) {
    this.platformFilter = platform;
    this.showPlatformFilter = false;
    if (platform === 'All') {
      this.unifiedTable.filter('', 'source_platform', 'contains');
    } else {
      this.unifiedTable.filter(platform, 'source_platform', 'equals');
    }
  }

  // Salary filter
  get filteredUnifiedJobs(): UnifiedJob[] {
    if (!this.salaryFilterActive) return this.unifiedJobs;
    return this.unifiedJobs.filter(job => {
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

  // --- Display Helpers ---
  formatSalaryRange(job: any): string {
    if (job.salary_text) return job.salary_text;
    if (job.salary_min && job.salary_max) {
      return `$${job.salary_min.toLocaleString()} - $${job.salary_max.toLocaleString()}`;
    }
    if (job.salary_min) return `$${job.salary_min.toLocaleString()}+`;
    if (job.salary_max) return `Up to $${job.salary_max.toLocaleString()}`;
    return '—';
  }

  // ============ Unified Feed & Auto-Refresh Methods ============

  ngOnDestroy() {
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
      const preferences = this.selectedCandidate?.preferences || null;

      await this.unifiedFeedService.refreshFeed(preferences, {
        maxJobsPerSource: 50,
        syncGmail: true
      });

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

    this.unifiedFeedService.clearState();
    this.analysisQueueService.clearCache();

    this.unifiedJobs = [];
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
  }

  private applySorting() {
    // Handled by PrimeNG table column sorting — no-op
  }

  scrollToNewJobs() {
    const newJobElement = document.querySelector('.job-card.is-new');
    if (newJobElement) {
      newJobElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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

  openJobUrl(url: string) {
    if (url) {
      window.open(url, '_blank');
    }
  }

  async startUnifiedFeed() {
    if (!this.selectedCandidate) return;

    this.setupUnifiedFeedSubscriptions();
    this.autoRefreshService.startTimer();
    await this.performUnifiedRefresh();
  }

  onResumeChangeForUnifiedFeed() {
    if (this.selectedResume) {
      this.analysisQueueService.clearQueue();

      const jobIds = this.unifiedFeedService.getState().jobs.map(j => j.id);
      this.analysisQueueService.addToQueue(jobIds);
      this.analysisQueueService.processQueue(this.selectedResume);
    }
  }

  private restoreAnalysisFromCache() {
    if (!this.selectedResume) return;

    const jobs = this.unifiedFeedService.getState().jobs;
    const jobsToAnalyze: string[] = [];

    for (const job of jobs) {
      const cached = this.analysisQueueService.getCachedAnalysis(
        job.id,
        this.selectedResume.id
      );

      if (cached) {
        this.unifiedFeedService.updateJobAnalysis(job.id, cached.result);
      } else if (!job.analyzed && !job.analyzing) {
        jobsToAnalyze.push(job.id);
      }
    }

    if (jobsToAnalyze.length > 0) {
      this.analysisQueueService.addToQueue(jobsToAnalyze);
      this.analysisQueueService.processQueue(this.selectedResume);
    }
  }
}
