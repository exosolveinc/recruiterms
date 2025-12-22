import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';

interface RecruiterStats {
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  role: string;
  total_applications: number;
  interviews: number;
  offers: number;
  last_active_at: string | null;
}

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

interface NewUserForm {
  email: string;
  fullName: string;
  role: 'user' | 'admin';
}

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.scss']
})
export class AdminDashboardComponent implements OnInit {
  profile: Profile | null = null;
  loading = true;

  // Stats
  stats = {
    totalRecruiters: 0,
    totalApplications: 0,
    totalInterviews: 0,
    totalOffers: 0,
    avgMatchScore: 0
  };

  // Data
  recruiters: RecruiterStats[] = [];
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

  // Add User Modal
  showAddUserModal = false;
  addingUser = false;
  addUserError = '';
  addUserSuccess = '';
  newUser: NewUserForm = {
    email: '',
    fullName: '',
    role: 'user'
  };

  // Edit User Modal
  showEditUserModal = false;
  editingUser = false;
  selectedRecruiter: RecruiterStats | null = null;
  editUserError = '';


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
      await Promise.all([
        this.loadRecruiters(),
        this.loadApplications()
      ]);
      this.calculateStats();
      this.extractFilterOptions();
    } catch (err) {
      console.error('Failed to load admin data:', err);
    }
  }

  async loadRecruiters() {
    const data = await this.supabase.getAdminRecruiterStats();
    this.recruiters = data;
  }

  async loadApplications() {
    const data = await this.supabase.getAdminApplications();
    this.applications = data;
  }

  calculateStats() {
    this.stats.totalRecruiters = this.recruiters.length;
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

  openAddUserModal() {
    this.showAddUserModal = true;
    this.addUserError = '';
    this.addUserSuccess = '';
    this.newUser = {
      email: '',
      fullName: '',
      role: 'user'
    };
  }

  closeAddUserModal() {
    this.showAddUserModal = false;
    this.addUserError = '';
    this.addUserSuccess = '';
  }

  async addUser() {
    if (!this.newUser.email || !this.newUser.fullName) {
      this.addUserError = 'Please fill in all fields';
      return;
    }

    this.addingUser = true;
    this.addUserError = '';
    this.addUserSuccess = '';

    try {
      await this.supabase.inviteUserToOrganization(
        this.newUser.email,
        this.newUser.fullName,
        this.newUser.role
      );

      // Updated message - no email is sent automatically
      this.addUserSuccess = `✓ Invitation created for ${this.newUser.email}!\n\nPlease tell them to sign up with this email address.`;

      // Refresh recruiters list after 3 seconds
      setTimeout(async () => {
        await this.loadRecruiters();
        this.calculateStats();
        this.closeAddUserModal();
      }, 3000);

    } catch (err: any) {
      console.error('Add user error:', err);
      this.addUserError = err.message || 'Failed to add user';
    } finally {
      this.addingUser = false;
    }
  }

  // ============================================================================
  // EDIT USER ROLE
  // ============================================================================

  openEditUserModal(recruiter: RecruiterStats) {
    this.selectedRecruiter = { ...recruiter };
    this.showEditUserModal = true;
    this.editUserError = '';
  }

  closeEditUserModal() {
    this.showEditUserModal = false;
    this.selectedRecruiter = null;
    this.editUserError = '';
  }

  async updateUserRole() {
    if (!this.selectedRecruiter) return;

    this.editingUser = true;
    this.editUserError = '';

    try {
      await this.supabase.updateUserRole(
        this.selectedRecruiter.user_id,
        this.selectedRecruiter.role as 'admin' | 'recruiter'
      );

      // Refresh list
      await this.loadRecruiters();
      this.closeEditUserModal();

    } catch (err: any) {
      console.error('Update role error:', err);
      this.editUserError = err.message || 'Failed to update role';
    } finally {
      this.editingUser = false;
    }
  }

  async removeUser(recruiter: RecruiterStats) {
    if (recruiter.user_id === this.profile?.id) {
      alert("You cannot remove yourself!");
      return;
    }

    const confirmMsg = `Remove ${recruiter.full_name || recruiter.email} from the organization?\n\nThis will revoke their access but won't delete their account.`;

    if (!confirm(confirmMsg)) return;

    try {
      await this.supabase.removeUserFromOrganization(recruiter.user_id);
      await this.loadRecruiters();
      this.calculateStats();
    } catch (err: any) {
      alert('Failed to remove user: ' + err.message);
    }
  }
}