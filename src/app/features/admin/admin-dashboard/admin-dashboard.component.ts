import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { TableModule, Table } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';

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
    MultiSelectModule
  ],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.scss']
})
export class AdminDashboardComponent implements OnInit {
  @ViewChild('dt') dt!: Table;

  profile: Profile | null = null;
  loading = true;
  lastUpdated = new Date();

  // Data
  applications: AdminApplication[] = [];

  // Stats
  stats = { totalApps: 0, interviews: 0, avgMatch: 0, avgSalary: 0 };

  // Pipeline
  pipeline = { extracted: 0, applied: 0, screening: 0, interviewing: 0, offer: 0, accepted: 0 };
  pipelineMax = 1;

  // Weekly activity (last 7 days)
  weeklyActivity: { day: string; count: number }[] = [];
  weeklyMax = 1;

  // Upcoming interviews
  upcomingInterviews: any[] = [];

  // Top matches
  topMatches: AdminApplication[] = [];

  // Table state
  searchTerm = '';
  selectedStatuses: string[] = [];

  // PrimeNG sort state
  sortField = '';
  sortOrder = 0;

  // Status filter options for multiselect
  statusFilterOptions = [
    { label: 'Applied', value: 'applied' },
    { label: 'Extracted', value: 'extracted' },
    { label: 'Screening', value: 'screening' },
    { label: 'Interviewing', value: 'interviewing' },
    { label: 'Offer', value: 'offer' },
    { label: 'Accepted', value: 'accepted' },
    { label: 'Rejected', value: 'rejected' }
  ];

  // Job Detail Modal
  showJobModal = false;
  selectedJob: Job | null = null;
  selectedResume: Resume | null = null;
  loadingJobDetails = false;

  // Circumference for SVG rings
  readonly RING_C = 2 * Math.PI * 17;

  constructor(
    private supabase: SupabaseService,
    private router: Router,
    private adminDashboardService: AdminDashboardService
  ) {}

  async ngOnInit() {
    await this.checkAdminAccess();

    // Use cached data if available for instant render
    const cached = this.adminDashboardService.cached;
    if (cached) {
      this.applications = cached.applications;
      this.upcomingInterviews = cached.upcomingInterviews;
      this.lastUpdated = cached.lastUpdated;
      this.computeStats();
      this.loading = false;
    } else {
      await this.loadData();
      this.loading = false;
    }
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

  async loadData(forceRefresh = false) {
    try {
      const data = await this.adminDashboardService.loadData(forceRefresh);
      this.applications = data.applications;
      this.upcomingInterviews = data.upcomingInterviews;
      this.lastUpdated = data.lastUpdated;
      this.computeStats();
    } catch (err) {
      console.error('Failed to load admin data:', err);
    }
  }

  async refreshData() {
    this.loading = true;
    await this.loadData(true);
    this.loading = false;
  }

  computeStats() {
    const apps = this.applications;
    this.stats.totalApps = apps.length;

    this.stats.interviews = apps.filter(a =>
      ['screening', 'interviewing', 'offer', 'accepted'].includes(a.status)
    ).length;

    const scoresWithValue = apps.filter(a => a.match_score);
    this.stats.avgMatch = scoresWithValue.length > 0
      ? Math.round(scoresWithValue.reduce((sum, a) => sum + (a.match_score || 0), 0) / scoresWithValue.length)
      : 0;

    const salaryApps = apps.filter(a => a.salary_min || a.salary_max);
    if (salaryApps.length > 0) {
      const totalSalary = salaryApps.reduce((sum, a) => {
        const avg = a.salary_min && a.salary_max ? (a.salary_min + a.salary_max) / 2 :
                    a.salary_min ? a.salary_min : a.salary_max!;
        return sum + avg;
      }, 0);
      this.stats.avgSalary = Math.round(totalSalary / salaryApps.length);
    }

    // Pipeline
    this.pipeline = { extracted: 0, applied: 0, screening: 0, interviewing: 0, offer: 0, accepted: 0 };
    for (const app of apps) {
      const s = app.status as keyof typeof this.pipeline;
      if (s in this.pipeline) {
        this.pipeline[s]++;
      }
    }
    this.pipelineMax = Math.max(
      this.pipeline.extracted, this.pipeline.applied, this.pipeline.screening,
      this.pipeline.interviewing, this.pipeline.offer, this.pipeline.accepted, 1
    );

    // Weekly activity
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    const counts: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const count = apps.filter(a => {
        const t = new Date(a.applied_at).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      counts.push({ day: dayNames[d.getDay()], count });
    }
    this.weeklyActivity = counts;
    this.weeklyMax = Math.max(...counts.map(c => c.count), 1);

    // Top matches
    this.topMatches = [...apps]
      .filter(a => a.match_score)
      .sort((a, b) => (b.match_score || 0) - (a.match_score || 0))
      .slice(0, 4);
  }

  // ============================================================================
  // TABLE (PrimeNG)
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
      if (this.selectedStatuses.length > 0) {
        this.dt.filter(this.selectedStatuses, 'status', 'in');
      }
    }
  }

  getSortIcon(field: string): string {
    if (this.sortField !== field || this.sortOrder === 0) return 'pi-sort-alt';
    return this.sortOrder === 1 ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down';
  }

  onStatusFilterChange() {
    if (this.selectedStatuses.length > 0) {
      this.dt.filter(this.selectedStatuses, 'status', 'in');
    } else {
      this.dt.filter(null, 'status', 'in');
    }
  }

  clearFilters() {
    if (this.dt) {
      this.dt.clear();
    }
    this.searchTerm = '';
    this.selectedStatuses = [];
    this.sortField = '';
    this.sortOrder = 0;
  }

  get hasActiveFilters(): boolean {
    return !!(this.searchTerm || this.selectedStatuses.length > 0);
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
  // HELPERS
  // ============================================================================

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  formatSalary(min: number | null, max: number | null): string {
    if (!min && !max) return '—';
    const format = (n: number) => `$${Math.round(n / 1000)}k`;
    if (min && max) return `${format(min)} – ${format(max)}`;
    if (min) return `${format(min)}+`;
    return `Up to ${format(max!)}`;
  }

  formatSalaryShort(value: number): string {
    if (value >= 1000) return `$${Math.round(value / 1000)}k`;
    return `$${value}`;
  }

  getMatchColor(score: number | null): string {
    if (!score) return '#9CA3AF';
    if (score >= 80) return '#16A34A';
    if (score >= 60) return '#D97706';
    return '#DC2626';
  }

  getRingOffset(score: number | null): number {
    if (!score) return this.RING_C;
    return this.RING_C - (score / 100) * this.RING_C;
  }

  getStatusClass(status: string): string {
    const map: Record<string, string> = {
      applied: 'status-applied',
      extracted: 'status-extracted',
      screening: 'status-screening',
      interviewing: 'status-interview',
      offer: 'status-offer',
      accepted: 'status-accepted',
      rejected: 'status-rejected',
      withdrawn: 'status-extracted'
    };
    return map[status] || 'status-extracted';
  }

  getInterviewTypeBadge(type: string): string {
    const map: Record<string, string> = {
      phone: 'Phone',
      video: 'Video',
      onsite: 'Onsite',
      technical: 'Technical',
      behavioral: 'Behavioral',
      panel: 'Panel',
      other: 'Interview'
    };
    return map[type] || type;
  }

  getInitials(name: string | null): string {
    if (!name) return '?';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  getPipelinePercent(count: number): number {
    return Math.max(8, (count / this.pipelineMax) * 100);
  }

  getBarHeight(count: number): number {
    return Math.max(4, (count / this.weeklyMax) * 120);
  }

  getConversionRate(): string {
    if (this.stats.totalApps === 0) return '0';
    const accepted = this.pipeline.accepted + this.pipeline.offer;
    return ((accepted / this.stats.totalApps) * 100).toFixed(1);
  }

  getMatchClass(score: number | null): string {
    if (!score) return '';
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }

  trackByIndex(index: number): number {
    return index;
  }

  async logout() {
    this.adminDashboardService.clearCache();
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  goToUserDashboard() {
    this.router.navigate(['/dashboard']);
  }
}
