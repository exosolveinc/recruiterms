import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Candidate, Profile, Resume, UnifiedJob } from '../../../core/models';
import { JobFeedDbService } from '../../../core/services/job-feed-db.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { SliderModule } from 'primeng/slider';
import { TableModule, Table } from 'primeng/table';

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, SliderModule, TableModule],
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
    await this.loadCandidates();

    // Load jobs for the selected candidate
    if (this.selectedCandidateId) {
      await this.jobFeedDbService.loadJobsForCandidate(this.selectedCandidateId);
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

    // Load jobs from DB for the new candidate
    this.jobFeedDbService.loadJobsForCandidate(candidateId);
  }

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
    // Re-analyze all jobs with the new resume
    if (this.selectedCandidateId) {
      this.jobFeedDbService.reanalyzeForResume(this.selectedCandidateId, resumeId);
    }
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

  markUnifiedJobAsSeen(_jobId: string) {
    // No-op: removed to prevent Realtime UPDATE events from collapsing expanded rows
  }

  openJobUrl(url: string) {
    if (url) {
      window.open(url, '_blank');
    }
  }
}
