import { CommonModule } from '@angular/common';
import { Component, effect, HostListener, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Candidate, Profile, Resume, UnifiedJob } from '../../../core/models';
import { AppStateService } from '../../../core/services/app-state.service';
import { JobFeedDbService } from '../../../core/services/job-feed-db.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { SliderModule } from 'primeng/slider';
import { TableModule, Table } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, SliderModule, TableModule, MultiSelectModule],
  templateUrl: './job-feed.component.html',
  styleUrl: './job-feed.component.scss'
})
export class JobFeedComponent implements OnInit, OnDestroy {
  Math = Math;
  private destroy$ = new Subject<void>();

  profile: Profile | null = null;

  // Unified Feed
  unifiedJobs: UnifiedJob[] = [];
  filteredUnifiedJobs: UnifiedJob[] = [];
  sourceFilter: 'all' | 'api' | 'email' = 'all';
  sortBy: 'date' | 'match' | 'salary' = 'date';
  newJobsCount = 0;

  // Loading / Refresh state
  isRefreshing = false;
  isLoading = false;

  // Candidates & Resumes (from AppState)
  private appState = inject(AppStateService);

  get selectedCandidateId(): string { return this.appState.selectedCandidateId(); }
  get selectedResumeId(): string { return this.appState.selectedResumeId(); }
  get selectedCandidate(): Candidate | null { return this.appState.selectedCandidate(); }
  get selectedResume(): Resume | null {
    const candidate = this.selectedCandidate;
    if (!candidate) return null;
    return candidate.resumes.find(r => r.id === this.selectedResumeId) || null;
  }
  get candidateResumes(): Resume[] {
    return this.selectedCandidate?.resumes || [];
  }

  // Effect to react to candidate changes from sidebar
  private candidateEffect = effect(() => {
    const candidateId = this.appState.selectedCandidateId();
    if (candidateId) {
      this.jobFeedDbService.loadJobsForCandidate(candidateId);
      this.loadFeedInsight(candidateId);
    }
  });

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

  // Company column filter
  companyOptions: { label: string; value: string }[] = [];
  selectedCompanies: string[] = [];

  // Skills expand state (tracks which jobs have skills expanded)
  skillsExpandedFor = new Set<string>();

  // AI Insight (cron-generated, read-only)
  feedInsight = signal<string | null>(null);
  insightLoading = signal(false);
  insightDismissed = signal(false);

  constructor(
    private supabase: SupabaseService,
    private jobFeedDbService: JobFeedDbService,
    private router: Router
  ) {}

  async ngOnInit() {
    // Subscribe to DB service observables
    this.jobFeedDbService.jobs$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jobs => {
        this.unifiedJobs = this.applySourceFilter(jobs);
        this.newJobsCount = jobs.filter(j => j.is_new).length;
        this.buildCompanyOptions();
        this.updateFilteredJobs();
      });

    this.jobFeedDbService.loading$
      .pipe(takeUntil(this.destroy$))
      .subscribe(loading => {
        this.isLoading = loading;
      });

    this.jobFeedDbService.refreshing$
      .pipe(takeUntil(this.destroy$))
      .subscribe(refreshing => {
        this.isRefreshing = refreshing;
      });

    await this.loadProfile();
  }

  async loadProfile() {
    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.profile = profile;
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

  // ============ PrimeNG Table Methods ============

  onUnifiedSort(event: Event, field: string) {
    if (this.unifiedSortField === field) {
      this.unifiedSortOrder = this.unifiedSortOrder === 1 ? -1 : 1;
    } else {
      this.unifiedSortField = field;
      this.unifiedSortOrder = -1;
    }

    this.unifiedTable.sortField = this.unifiedSortField;
    this.unifiedTable.sortOrder = this.unifiedSortOrder;
    this.unifiedTable.sortSingle();
  }

  getUnifiedSortIcon(field: string): string {
    if (this.unifiedSortField !== field) return 'pi-sort-alt';
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
    this.selectedCompanies = [];
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
  private updateFilteredJobs(): void {
    if (!this.salaryFilterActive) {
      this.filteredUnifiedJobs = this.unifiedJobs;
      return;
    }
    this.filteredUnifiedJobs = this.unifiedJobs.filter(job => {
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
    this.updateFilteredJobs();
  }

  clearSalaryFilter() {
    this.salaryRange = [0, 300000];
    this.salaryFilterActive = false;
    this.updateFilteredJobs();
  }

  // Company filter
  private buildCompanyOptions() {
    const companies = new Set<string>();
    this.unifiedJobs.forEach(j => {
      if (j.company) companies.add(j.company);
    });
    this.companyOptions = Array.from(companies).sort().map(c => ({ label: c, value: c }));
  }

  onCompanyFilterChange() {
    if (this.selectedCompanies.length > 0) {
      this.unifiedTable.filter(this.selectedCompanies, 'company', 'in');
    } else {
      this.unifiedTable.filter(null, 'company', 'in');
    }
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

  // ============ Feed Actions ============

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  manualRefresh() {
    if (this.selectedCandidateId) {
      this.jobFeedDbService.triggerRefresh(this.selectedCandidateId);
    }
  }

  filterBySource(source: 'all' | 'api' | 'email') {
    this.sourceFilter = source;
    // Re-apply source filter from the current snapshot
    this.unifiedJobs = this.applySourceFilter(this.jobFeedDbService.currentJobs);
    this.updateFilteredJobs();
  }

  private applySourceFilter(jobs: UnifiedJob[]): UnifiedJob[] {
    if (this.sourceFilter === 'all') {
      return jobs;
    }
    return jobs.filter(job => job.source_type === this.sourceFilter);
  }

  getTotalSkillCount(job: UnifiedJob): number {
    return (job.matching_skills?.length || 0) + (job.missing_skills?.length || 0);
  }

  isSkillsExpanded(jobId: string): boolean {
    return this.skillsExpandedFor.has(jobId);
  }

  toggleSkillsExpanded(jobId: string) {
    if (this.skillsExpandedFor.has(jobId)) {
      this.skillsExpandedFor.delete(jobId);
    } else {
      this.skillsExpandedFor.add(jobId);
    }
  }

  getVisibleSkills(job: UnifiedJob, type: 'matching' | 'missing'): string[] {
    const matching = job.matching_skills || [];
    const missing = job.missing_skills || [];
    const total = matching.length + missing.length;

    if (total <= 8 || this.skillsExpandedFor.has(job.id)) {
      return type === 'matching' ? matching : missing;
    }

    // Show first 8 combined, split between matching and missing
    if (type === 'matching') {
      return matching.slice(0, 8);
    }
    const remainingSlots = 8 - matching.length;
    return remainingSlots > 0 ? missing.slice(0, remainingSlots) : [];
  }

  openJobUrl(url: string) {
    if (url) {
      window.open(url, '_blank');
    }
  }

  selectResume(resumeId: string) {
    this.appState.selectResume(resumeId);
    if (this.selectedCandidateId) {
      this.jobFeedDbService.reanalyzeForResume(this.selectedCandidateId, resumeId);
    }
  }

  async loadFeedInsight(candidateId: string): Promise<void> {
    this.insightLoading.set(true);
    this.insightDismissed.set(false);
    try {
      const content = await this.supabase.getTodayJobFeedInsight(candidateId);
      this.feedInsight.set(content);
    } catch {
      // Silently fail
    } finally {
      this.insightLoading.set(false);
    }
  }

  dismissInsight(): void {
    this.insightDismissed.set(true);
  }
}
