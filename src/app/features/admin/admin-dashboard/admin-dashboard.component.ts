import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

// PrimeNG imports
import { TableModule, Table } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';

interface AdminApplication {
  id: string;
  user_id: string;
  recruiter_name: string;
  recruiter_email: string;
  job_id: string;
  resume_id: string | null;
  job_title: string | null;
  company_name: string | null;
  platform: string | null;
  location: string | null;
  work_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  match_score: number | null;
  experience_level: string | null;
  required_skills: any[] | null;
  status: string;
  applied_at: string;
}

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SidebarComponent,
    TableModule,
    MultiSelectModule,
    TagModule
  ],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.scss']
})
export class AdminDashboardComponent implements OnInit {
  @ViewChild('dt') dt!: Table;

  profile: Profile | null = null;
  loading = true;

  // Stats
  stats = {
    totalApplications: 0,
    totalInterviews: 0,
    totalOffers: 0,
    avgMatchScore: 0
  };

  // Data
  applications: AdminApplication[] = [];

  // Search
  searchTerm = '';

  // PrimeNG sort state
  sortField = '';
  sortOrder = 0;

  // Filter options for multi-selects
  recruiterOptions: { label: string; value: string }[] = [];
  statusOptions: { label: string; value: string }[] = [];
  platformOptions: { label: string; value: string }[] = [];

  // Selected filter values
  selectedRecruiters: string[] = [];
  selectedStatuses: string[] = [];
  selectedPlatforms: string[] = [];

  // Job Detail Modal
  showJobModal = false;
  selectedJob: Job | null = null;
  selectedResume: Resume | null = null;
  loadingJobDetails = false;

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) { }

  async ngOnInit() {
    await this.checkAdminAccess();
    await this.loadData();
    this.loading = false;
  }

  async checkAdminAccess() {
    const profile = await this.supabase.getProfile();
    if (!profile) {
      this.router.navigate(['/auth/login']);
      return;
    }
    if (profile.role !== 'admin') {
      alert('Access denied. Admin only.');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.profile = profile;
  }

  async loadData() {
    try {
      await this.loadApplications();
      this.calculateStats();
      this.buildFilterOptions();
    } catch (err) {
      console.error('Failed to load admin data:', err);
    }
  }

  async loadApplications() {
    const data = await this.supabase.getAdminApplications();
    this.applications = data;
  }

  calculateStats() {
    this.stats.totalApplications = this.applications.length;
    this.stats.totalInterviews = this.applications.filter(a =>
      ['screening', 'interviewing', 'offer', 'accepted'].includes(a.status)
    ).length;
    this.stats.totalOffers = this.applications.filter(a =>
      ['offer', 'accepted'].includes(a.status)
    ).length;

    const scoresWithValue = this.applications.filter(a => a.match_score);
    this.stats.avgMatchScore = scoresWithValue.length > 0
      ? Math.round(scoresWithValue.reduce((sum, a) => sum + (a.match_score || 0), 0) / scoresWithValue.length)
      : 0;
  }

  buildFilterOptions() {
    // Recruiters
    const seen = new Set<string>();
    this.recruiterOptions = [];
    for (const app of this.applications) {
      if (!seen.has(app.user_id)) {
        seen.add(app.user_id);
        this.recruiterOptions.push({
          label: app.recruiter_name || app.recruiter_email,
          value: app.user_id
        });
      }
    }

    // Statuses
    const statuses = [...new Set(this.applications.map(a => a.status).filter(Boolean))];
    this.statusOptions = statuses.map(s => ({
      label: s.charAt(0).toUpperCase() + s.slice(1),
      value: s
    }));

    // Platforms
    const platforms = [...new Set(
      this.applications.map(a => a.platform).filter((p): p is string => !!p)
    )];
    this.platformOptions = platforms.map(p => ({ label: p, value: p }));
  }

  // ============================================================================
  // TABLE INTERACTION
  // ============================================================================

  onGlobalFilter(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.dt.filterGlobal(value, 'contains');
  }

  onSort(event: Event, field: string) {
    if (this.sortField === field) {
      this.sortOrder = this.sortOrder === 1 ? -1 : 0;
    } else {
      this.sortField = field;
      this.sortOrder = 1;
    }

    if (this.sortOrder !== 0) {
      this.dt.sortField = this.sortField;
      this.dt.sortOrder = this.sortOrder;
      this.dt.sortSingle();
    } else {
      this.sortField = '';
      this.dt.reset();
      // Re-apply active filters after reset
      if (this.searchTerm) this.dt.filterGlobal(this.searchTerm, 'contains');
      if (this.selectedRecruiters.length) this.dt.filter(this.selectedRecruiters, 'user_id', 'in');
      if (this.selectedStatuses.length) this.dt.filter(this.selectedStatuses, 'status', 'in');
      if (this.selectedPlatforms.length) this.dt.filter(this.selectedPlatforms, 'platform', 'in');
    }
  }

  getSortIcon(field: string): string {
    if (this.sortField !== field || this.sortOrder === 0) return 'pi-sort-alt';
    return this.sortOrder === 1 ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down';
  }

  onRecruiterFilterChange() {
    this.dt.filter(this.selectedRecruiters.length ? this.selectedRecruiters : null, 'user_id', 'in');
  }

  onStatusFilterChange() {
    this.dt.filter(this.selectedStatuses.length ? this.selectedStatuses : null, 'status', 'in');
  }

  onPlatformFilterChange() {
    this.dt.filter(this.selectedPlatforms.length ? this.selectedPlatforms : null, 'platform', 'in');
  }

  clearFilters() {
    this.dt.clear();
    this.searchTerm = '';
    this.selectedRecruiters = [];
    this.selectedStatuses = [];
    this.selectedPlatforms = [];
    this.sortField = '';
    this.sortOrder = 0;
  }

  get hasActiveFilters(): boolean {
    return !!(this.searchTerm || this.selectedRecruiters.length || this.selectedStatuses.length || this.selectedPlatforms.length);
  }

  // ============================================================================
  // JOB DETAIL MODAL
  // ============================================================================

  async viewJobDetails(app: AdminApplication) {
    this.loadingJobDetails = true;
    this.showJobModal = true;

    try {
      this.selectedJob = await this.supabase.getJob(app.job_id);

      if (app.resume_id) {
        this.selectedResume = await this.supabase.getResume(app.resume_id);
      } else {
        this.selectedResume = null;
      }
    } catch (err) {
      console.error('Failed to load job details:', err);
    } finally {
      this.loadingJobDetails = false;
    }
  }

  closeJobModal() {
    this.showJobModal = false;
    this.selectedJob = null;
    this.selectedResume = null;
  }

  // ============================================================================
  // FORMAT HELPERS
  // ============================================================================

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  formatSalary(min: number | null, max: number | null): string {
    if (!min && !max) return 'Not listed';
    const format = (n: number) => `$${Math.round(n / 1000)}k`;
    if (min && max) return `${format(min)} - ${format(max)}`;
    if (min) return `${format(min)}+`;
    return `Up to ${format(max!)}`;
  }

  getStatusSeverity(status: string): 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast' | undefined {
    const map: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast'> = {
      'applied': 'info',
      'screening': 'warning',
      'interviewing': 'contrast',
      'offer': 'success',
      'accepted': 'success',
      'rejected': 'danger',
      'withdrawn': 'secondary'
    };
    return map[status] || 'info';
  }

  getStatusClass(status: string): string {
    const classes: Record<string, string> = {
      'applied': 'status-applied',
      'screening': 'status-screening',
      'interviewing': 'status-interviewing',
      'offer': 'status-offer',
      'accepted': 'status-accepted',
      'rejected': 'status-rejected',
      'withdrawn': 'status-withdrawn'
    };
    return classes[status] || 'status-applied';
  }

  getMatchClass(score: number | null): string {
    if (!score) return '';
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }

  getInitials(name: string): string {
    if (!name) return '?';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  goToUserDashboard() {
    this.router.navigate(['/dashboard']);
  }
}
