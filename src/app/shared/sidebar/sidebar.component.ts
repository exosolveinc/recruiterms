import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { SupabaseService } from '../../core/services/supabase.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  @Input() activePage: string = '';

  navItems = [
    { icon: '📋', label: 'Dashboard', route: '/dashboard', id: 'dashboard' },
    { icon: '📄', label: 'Resumes', route: '/resumes', id: 'resumes' },
    { icon: '👥', label: 'Candidates', route: '/candidates', id: 'candidates' },
    { icon: '🔍', label: 'Job Feed', route: '/job-feed', id: 'job-feed' }
  ];

  constructor(
    private router: Router,
    private supabase: SupabaseService
  ) {}

  navigate(route: string) {
    this.router.navigate([route]);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
