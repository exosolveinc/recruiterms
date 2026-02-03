import { CommonModule } from '@angular/common';
import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { Profile } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';

interface NavItem {
  icon: string;
  label: string;
  route: string;
  id: string;
  adminOnly?: boolean;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent implements OnInit, OnDestroy {
  @Input() activePage: string = '';

  profile: Profile | null = null;
  isAdmin = false;
  private profileSub?: Subscription;

  allNavItems: NavItem[] = [
    { icon: 'fi-rr-apps', label: 'Admin Dashboard', route: '/admin', id: 'admin', adminOnly: true },
    { icon: 'fi-rr-clipboard-list', label: 'Applications', route: '/dashboard', id: 'dashboard' },
    { icon: 'fi-rr-document', label: 'Resumes', route: '/resumes', id: 'resumes' },
    { icon: 'fi-rr-users', label: 'Candidates', route: '/candidates', id: 'candidates' },
    { icon: 'fi-rr-briefcase', label: 'Job Feed', route: '/job-feed', id: 'job-feed' },
    { icon: 'fi fi-rr-calendar-clock', label: 'Interview Management', route: '/interviews', id: 'interviews' },
  ];

  get navItems(): NavItem[] {
    return this.allNavItems.filter(item => !item.adminOnly || this.isAdmin);
  }

  constructor(
    private router: Router,
    private supabase: SupabaseService
  ) {}

  ngOnInit() {
    // Subscribe to cached profile observable - no API call needed
    this.profileSub = this.supabase.profile$.subscribe(profile => {
      this.profile = profile;
      this.isAdmin = profile?.role === 'admin';
    });
  }

  ngOnDestroy() {
    this.profileSub?.unsubscribe();
  }

  navigate(route: string) {
    this.router.navigate([route]);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
