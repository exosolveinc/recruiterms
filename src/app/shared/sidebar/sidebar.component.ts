import { CommonModule } from '@angular/common';
import { Component, HostListener, Input, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { Candidate, Profile } from '../../core/models';
import { AppStateService } from '../../core/services/app-state.service';
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
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent implements OnInit, OnDestroy {
  @Input() activePage: string = '';

  profile: Profile | null = null;
  isAdmin = false;
  private profileSub?: Subscription;

  // Candidate selector
  showCandidatePopover = false;
  candidateSearchQuery = '';

  allNavItems: NavItem[] = [
    { icon: 'fi-rr-apps', label: 'Admin Dashboard', route: '/admin', id: 'admin', adminOnly: true },
    { icon: 'fi-rr-clipboard-list', label: 'Applications', route: '/dashboard', id: 'dashboard' },
    { icon: 'fi-rr-columns-3', label: 'Applications Board', route: '/applications-board', id: 'applications-board' },
{ icon: 'fi-rr-users', label: 'Candidates', route: '/candidates', id: 'candidates' },
    { icon: 'fi-rr-search', label: 'Job Search', route: '/job-search', id: 'job-search' },
    { icon: 'fi-rr-briefcase', label: 'Job Feed', route: '/job-feed', id: 'job-feed' },
    { icon: 'fi-rr-calendar-clock', label: 'Interview Management', route: '/interviews', id: 'interviews' },
    { icon: 'fi-rr-settings', label: 'Profile & Settings', route: '/profile', id: 'profile' },
  ];

  get navItems(): NavItem[] {
    return this.allNavItems.filter(item => !item.adminOnly || this.isAdmin);
  }

  constructor(
    private router: Router,
    private supabase: SupabaseService,
    private appState: AppStateService
  ) {}

  async ngOnInit() {
    this.profileSub = this.supabase.profile$.subscribe(profile => {
      this.profile = profile;
      this.isAdmin = profile?.role === 'admin';
    });

    // Load candidates if not already loaded
    if (!this.appState.candidatesLoaded()) {
      try {
        const candidates = await this.supabase.getCandidates();
        this.appState.setCandidates(candidates);
      } catch (err) {
        console.error('Failed to load candidates in sidebar:', err);
      }
    }
  }

  ngOnDestroy() {
    this.profileSub?.unsubscribe();
  }

  get candidates(): Candidate[] {
    return this.appState.candidates();
  }

  get selectedCandidateId(): string {
    return this.appState.selectedCandidateId();
  }

  get selectedCandidate(): Candidate | null {
    return this.appState.selectedCandidate();
  }

  get filteredCandidates(): Candidate[] {
    const all = this.candidates;
    if (!this.candidateSearchQuery.trim()) return all;
    const query = this.candidateSearchQuery.toLowerCase();
    return all.filter(c =>
      c.name.toLowerCase().includes(query) ||
      (c.current_title && c.current_title.toLowerCase().includes(query))
    );
  }

  toggleCandidateSelector(event: Event) {
    event.stopPropagation();
    this.showCandidatePopover = !this.showCandidatePopover;
    if (this.showCandidatePopover) {
      this.candidateSearchQuery = '';
    }
  }

  selectCandidate(candidateId: string) {
    this.appState.selectCandidate(candidateId);
    this.showCandidatePopover = false;
  }

  @HostListener('document:click')
  onDocumentClick() {
    this.showCandidatePopover = false;
  }

  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  navigate(route: string) {
    this.router.navigate([route]);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
