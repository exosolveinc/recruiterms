import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Candidate, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

@Component({
  selector: 'app-candidates',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent],
  templateUrl: './candidates.component.html',
  styleUrl: './candidates.component.scss'
})
export class CandidatesComponent implements OnInit {
  profile: Profile | null = null;
  candidates: Candidate[] = [];
  loading = true;
  searchTerm = '';
  skillFilter = '';

  // Expandable rows
  expandedCandidateId: string | null = null;

  // Modal
  showCandidateModal = false;
  selectedCandidate: Candidate | null = null;
  selectedResume: Resume | null = null;

  // Stats
  stats = {
    totalCandidates: 0,
    totalResumes: 0,
    avgExperience: 0
  };

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  async ngOnInit() {
    await this.loadProfile();
    await this.loadCandidates();
    this.loading = false;
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
      // Use org-level for admin, user-level otherwise
      if (this.profile?.role === 'admin') {
        this.candidates = await this.supabase.getAllCandidatesForOrg();
      } else {
        this.candidates = await this.supabase.getCandidates();
      }
      this.calculateStats();
    } catch (err) {
      console.error('Failed to load candidates:', err);
      this.candidates = [];
    }
  }

  calculateStats() {
    this.stats.totalCandidates = this.candidates.length;
    this.stats.totalResumes = this.candidates.reduce((sum, c) => sum + c.resume_count, 0);

    const candidatesWithExp = this.candidates.filter(c => c.years_of_experience);
    if (candidatesWithExp.length > 0) {
      this.stats.avgExperience = Math.round(
        candidatesWithExp.reduce((sum, c) => sum + (c.years_of_experience || 0), 0) / candidatesWithExp.length
      );
    }
  }

  get filteredCandidates(): Candidate[] {
    let filtered = this.candidates;

    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(term) ||
        c.email?.toLowerCase().includes(term) ||
        c.current_title?.toLowerCase().includes(term) ||
        c.current_company?.toLowerCase().includes(term) ||
        c.location?.toLowerCase().includes(term)
      );
    }

    if (this.skillFilter) {
      const skill = this.skillFilter.toLowerCase();
      filtered = filtered.filter(c =>
        c.skills.some(s => s.name.toLowerCase().includes(skill))
      );
    }

    return filtered;
  }

  get allSkills(): string[] {
    const skillSet = new Set<string>();
    this.candidates.forEach(c => {
      c.skills.forEach(s => skillSet.add(s.name));
    });
    return Array.from(skillSet).sort();
  }

  toggleExpand(candidateId: string, event: Event) {
    event.stopPropagation();
    this.expandedCandidateId = this.expandedCandidateId === candidateId ? null : candidateId;
  }

  isExpanded(candidateId: string): boolean {
    return this.expandedCandidateId === candidateId;
  }

  viewCandidate(candidate: Candidate) {
    this.selectedCandidate = candidate;
    this.selectedResume = candidate.resumes[0] || null;
    this.showCandidateModal = true;
  }

  selectResume(resume: Resume) {
    this.selectedResume = resume;
  }

  closeCandidateModal() {
    this.showCandidateModal = false;
    this.selectedCandidate = null;
    this.selectedResume = null;
  }

  openResumeFile(resume: Resume) {
    if (resume.file_url) {
      window.open(resume.file_url, '_blank');
    }
  }

  downloadResume(resume: Resume) {
    if (!resume.file_url) return;

    const link = document.createElement('a');
    link.href = resume.file_url;
    link.target = '_blank';
    link.download = resume.file_name || 'resume';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  getExperienceBadgeClass(level: string | null): string {
    if (!level) return '';
    const l = level.toLowerCase();
    if (l.includes('senior') || l.includes('lead') || l.includes('principal')) return 'exp-senior';
    if (l.includes('mid') || l.includes('intermediate')) return 'exp-mid';
    if (l.includes('junior') || l.includes('entry')) return 'exp-junior';
    return '';
  }

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  goToResumes() {
    this.router.navigate(['/resumes']);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
