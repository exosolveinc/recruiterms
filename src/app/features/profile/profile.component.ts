import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ActivityLog, NotificationPreferences, Profile, UserDashboard } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { CandidatesComponent } from '../candidates/candidates/candidates.component';

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
  created_at: string;
}

interface NewUserForm {
  email: string;
  fullName: string;
  role: 'user' | 'admin';
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, CandidatesComponent],
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss']
})
export class ProfileComponent implements OnInit {
  activeTab: 'profile' | 'team' | 'candidates' | 'notifications' = 'profile';

  profile: Profile | null = null;
  loading = true;
  organizationName = '';

  // Profile editing
  editingProfile = false;
  profileForm = { full_name: '', role: 'user' as string };
  savingProfile = false;
  profileSaveSuccess = false;

  // Stats & Activity
  userStats: UserDashboard | null = null;
  recentActivity: ActivityLog[] = [];

  // Team Members (admin only)
  recruiters: RecruiterStats[] = [];
  showAddUserModal = false;
  addingUser = false;
  addUserError = '';
  addUserSuccess = '';
  newUser: NewUserForm = {
    email: '',
    fullName: '',
    role: 'user'
  };

  showEditUserModal = false;
  editingUser = false;
  selectedRecruiter: RecruiterStats | null = null;
  editUserError = '';

  // Notifications
  notifPrefs: NotificationPreferences | null = null;
  savingNotifPref = false;

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  async ngOnInit() {
    try {
      const profile = await this.supabase.getProfile();
      if (!profile) {
        this.router.navigate(['/auth/login']);
        return;
      }
      this.profile = profile;
      this.profileForm.full_name = profile.full_name || '';
      this.profileForm.role = profile.role || 'user';

      // Load org name, stats, activity in parallel
      const promises: Promise<any>[] = [
        this.loadUserStats(),
        this.loadRecentActivity(),
        this.loadNotificationPreferences()
      ];

      if (profile.organization_id) {
        promises.push(
          this.supabase.getOrganization(profile.organization_id).then(org => {
            this.organizationName = org?.name || '';
          }).catch(() => {
            this.organizationName = '';
          })
        );
      }

      if (profile.role === 'admin') {
        promises.push(this.loadRecruiters());
      }

      await Promise.all(promises);
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      this.loading = false;
    }
  }

  // ============================================================================
  // TABS
  // ============================================================================

  setTab(tab: 'profile' | 'team' | 'candidates' | 'notifications') {
    this.activeTab = tab;
  }

  // ============================================================================
  // STATS & ACTIVITY
  // ============================================================================

  async loadUserStats() {
    this.userStats = await this.supabase.getUserDashboard();
  }

  async loadRecentActivity() {
    this.recentActivity = await this.supabase.getUserRecentActivity(5);
  }

  formatActivityText(activity: ActivityLog): string {
    const action = activity.action || '';
    const details = activity.details || {};
    const entityType = activity.entity_type || '';

    if (details['description']) {
      return details['description'];
    }

    switch (action) {
      case 'status_changed': {
        const status = (details['new_status'] || '').replace(/_/g, ' ');
        return `${entityType === 'application' ? 'Application' : entityType} status changed to ${status}`;
      }
      case 'application_submitted':
        return 'Submitted a new application';
      case 'job_extracted': {
        const company = details['company'] || '';
        const platform = details['platform'] || '';
        return company
          ? `Extracted job from ${company}${platform ? ` (${platform})` : ''}`
          : 'Extracted a new job';
      }
      case 'resume_uploaded':
        return `Uploaded resume: ${details['file_name'] || ''}`;
      case 'job_created':
        return `Created job: ${details['title'] || details['company'] || ''}`;
      default: {
        const label = action.replace(/_/g, ' ');
        return entityType ? `${label} (${entityType})` : label;
      }
    }
  }

  timeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}w ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ============================================================================
  // PROFILE
  // ============================================================================

  startEditing() {
    this.editingProfile = true;
    this.profileSaveSuccess = false;
  }

  cancelEditing() {
    this.editingProfile = false;
    this.profileForm.full_name = this.profile?.full_name || '';
    this.profileForm.role = this.profile?.role || 'user';
    this.profileSaveSuccess = false;
  }

  async saveProfile() {
    this.savingProfile = true;
    this.profileSaveSuccess = false;

    try {
      const updated = await this.supabase.updateProfile({
        full_name: this.profileForm.full_name,
        role: this.profileForm.role as any
      });
      this.profile = updated;
      this.editingProfile = false;
      this.profileSaveSuccess = true;
      setTimeout(() => this.profileSaveSuccess = false, 3000);
    } catch (err: any) {
      console.error('Failed to save profile:', err);
      alert('Failed to save profile: ' + (err.message || 'Unknown error'));
    } finally {
      this.savingProfile = false;
    }
  }

  // ============================================================================
  // TEAM MEMBERS
  // ============================================================================

  async loadRecruiters() {
    const data = await this.supabase.getAdminRecruiterStats();
    this.recruiters = data;
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

      this.addUserSuccess = `Invitation created for ${this.newUser.email}!\n\nPlease tell them to sign up with this email address.`;

      setTimeout(async () => {
        await this.loadRecruiters();
        this.closeAddUserModal();
      }, 3000);

    } catch (err: any) {
      console.error('Add user error:', err);
      this.addUserError = err.message || 'Failed to add user';
    } finally {
      this.addingUser = false;
    }
  }

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
    } catch (err: any) {
      alert('Failed to remove user: ' + err.message);
    }
  }

  // ============================================================================
  // NOTIFICATIONS
  // ============================================================================

  async loadNotificationPreferences() {
    this.notifPrefs = await this.supabase.getNotificationPreferences();
  }

  async toggleNotifPref(key: string) {
    if (!this.notifPrefs || this.savingNotifPref) return;

    const currentValue = (this.notifPrefs as any)[key];
    (this.notifPrefs as any)[key] = !currentValue;

    this.savingNotifPref = true;
    try {
      const updated = await this.supabase.updateNotificationPreferences({
        [key]: !currentValue
      });
      if (updated) {
        this.notifPrefs = updated;
      }
    } catch (err) {
      console.error('Failed to update notification preference:', err);
      // Revert on failure
      (this.notifPrefs as any)[key] = currentValue;
    } finally {
      this.savingNotifPref = false;
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  getInitials(name: string): string {
    if (!name) return '?';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  formatShortDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
}
