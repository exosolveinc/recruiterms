import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

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
  imports: [CommonModule, FormsModule, SidebarComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.scss']
})
export class AdminDashboardComponent implements OnInit {
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

  // Filters
  searchTerm = '';
  recruiterFilter = 'all';
  statusFilter = 'all';
  platformFilter = 'all';

  // Job Detail Modal
  showJobModal = false;
  selectedJob: Job | null = null;
  selectedResume: Resume | null = null;
  loadingJobDetails = false;

  // Unique values for filters
  platforms: string[] = [];
  recruiters: { user_id: string; name: string }[] = [];

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
      this.extractFilterOptions();
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

  extractFilterOptions() {
    this.platforms = [...new Set(
      this.applications
        .map(a => a.platform)
        .filter((p): p is string => !!p)
    )];

    const seen = new Set<string>();
    this.recruiters = [];
    for (const app of this.applications) {
      if (!seen.has(app.user_id)) {
        seen.add(app.user_id);
        this.recruiters.push({
          user_id: app.user_id,
          name: app.recruiter_name || app.recruiter_email
        });
      }
    }
  }

  get filteredApplications(): AdminApplication[] {
    return this.applications.filter(app => {
      const matchesSearch = !this.searchTerm ||
        app.company_name?.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        app.job_title?.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        app.recruiter_name?.toLowerCase().includes(this.searchTerm.toLowerCase());

      const matchesRecruiter = this.recruiterFilter === 'all' ||
        app.user_id === this.recruiterFilter;

      const matchesStatus = this.statusFilter === 'all' ||
        app.status === this.statusFilter;

      const matchesPlatform = this.platformFilter === 'all' ||
        app.platform === this.platformFilter;

      return matchesSearch && matchesRecruiter && matchesStatus && matchesPlatform;
    });
  }

  // View Job Details
  async viewJobDetails(app: AdminApplication) {
    this.loadingJobDetails = true;
    this.showJobModal = true;

    try {
      // Load full job details
      this.selectedJob = await this.supabase.getJob(app.job_id);

      // Load resume if exists
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

  // Format helpers
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

  getSkills(skills: any[] | null): string[] {
    if (!skills) return [];
    return skills.slice(0, 3).map(s => typeof s === 'string' ? s : s.skill);
  }

  getInitials(name: string): string {
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