import { CommonModule } from '@angular/common';
import { Component, Input, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
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
export class SidebarComponent implements OnInit {
  @Input() activePage: string = '';

  profile: Profile | null = null;
  isAdmin = false;

  allNavItems: NavItem[] = [
    { icon: '📋', label: 'Applications', route: '/dashboard', id: 'dashboard' },
    { icon: '📄', label: 'Resumes', route: '/resumes', id: 'resumes' },
    { icon: '👥', label: 'Candidates', route: '/candidates', id: 'candidates' },
    { icon: '🔍', label: 'Job Feed', route: '/job-feed', id: 'job-feed' }
  ];

  get navItems(): NavItem[] {
    return this.allNavItems.filter(item => !item.adminOnly || this.isAdmin);
  }

  constructor(
    private router: Router,
    private supabase: SupabaseService
  ) {}

  async ngOnInit() {
    await this.loadProfile();
  }

  async loadProfile() {
    try {
      this.profile = await this.supabase.getProfile();
      this.isAdmin = this.profile?.role === 'admin';
    } catch (err) {
      console.error('Failed to load profile:', err);
    }
  }

  navigate(route: string) {
    this.router.navigate([route]);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
