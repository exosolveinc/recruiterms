import { Injectable, signal, computed } from '@angular/core';
import { Candidate, Resume, UserApplicationView, Profile } from '../models';

/**
 * Centralized state management service using Angular Signals.
 * This service acts as a single source of truth for app-wide state,
 * reducing redundant API calls across components.
 */
@Injectable({
  providedIn: 'root'
})
export class AppStateService {
  // ============================================================================
  // PROFILE STATE
  // ============================================================================
  private _profile = signal<Profile | null>(null);
  private _profileLoaded = signal(false);

  readonly profile = this._profile.asReadonly();
  readonly profileLoaded = this._profileLoaded.asReadonly();

  readonly isAdmin = computed(() => this._profile()?.role === 'admin');

  // ============================================================================
  // CANDIDATES STATE
  // ============================================================================
  private _candidates = signal<Candidate[]>([]);
  private _candidatesLoaded = signal(false);
  private _candidatesLoading = signal(false);

  readonly candidates = this._candidates.asReadonly();
  readonly candidatesLoaded = this._candidatesLoaded.asReadonly();
  readonly candidatesLoading = this._candidatesLoading.asReadonly();

  // ============================================================================
  // RESUMES STATE (all resumes, flattened)
  // ============================================================================
  private _resumes = signal<Resume[]>([]);
  private _resumesLoaded = signal(false);

  readonly resumes = this._resumes.asReadonly();
  readonly resumesLoaded = this._resumesLoaded.asReadonly();

  // ============================================================================
  // APPLICATIONS STATE
  // ============================================================================
  private _applications = signal<UserApplicationView[]>([]);
  private _applicationsLoaded = signal(false);
  private _applicationsLoading = signal(false);

  readonly applications = this._applications.asReadonly();
  readonly applicationsLoaded = this._applicationsLoaded.asReadonly();
  readonly applicationsLoading = this._applicationsLoading.asReadonly();

  // ============================================================================
  // SELECTED STATE
  // ============================================================================
  private _selectedCandidateId = signal<string>('');
  private _selectedResumeId = signal<string>('');

  readonly selectedCandidateId = this._selectedCandidateId.asReadonly();
  readonly selectedResumeId = this._selectedResumeId.asReadonly();

  readonly selectedCandidate = computed(() => {
    const id = this._selectedCandidateId();
    if (!id) return null;
    return this._candidates().find(c => c.id === id) || null;
  });

  readonly selectedResume = computed(() => {
    const id = this._selectedResumeId();
    if (!id) return null;
    return this._resumes().find(r => r.id === id) || null;
  });

  readonly candidateResumes = computed(() => {
    const candidate = this.selectedCandidate();
    if (!candidate) return [];
    return candidate.resumes || [];
  });

  // ============================================================================
  // FILTERED APPLICATIONS (by selected candidate)
  // ============================================================================
  readonly filteredApplications = computed(() => {
    const apps = this._applications();
    const candidateId = this._selectedCandidateId();

    if (!candidateId) return apps;

    const candidate = this._candidates().find(c => c.id === candidateId);
    if (!candidate) return apps;

    const candidateResumeIds = new Set(candidate.resumes.map(r => r.id));
    return apps.filter(app => app.resume_id && candidateResumeIds.has(app.resume_id));
  });

  // ============================================================================
  // COMPUTED STATS
  // ============================================================================
  readonly candidateStats = computed(() => {
    const apps = this.filteredApplications();
    const applied = apps.length;
    const interviews = apps.filter(a =>
      ['interviewing', 'screening', 'offer', 'accepted'].includes(a.status)
    ).length;
    const interviewRate = applied > 0 ? Math.round((interviews / applied) * 100) : 0;

    // Average match score
    const appsWithScore = apps.filter(a => a.match_score);
    const avgMatch = appsWithScore.length > 0
      ? Math.round(appsWithScore.reduce((sum, a) => sum + (a.match_score || 0), 0) / appsWithScore.length)
      : 0;

    return { applied, interviews, interviewRate, avgMatch };
  });

  // ============================================================================
  // PROFILE METHODS
  // ============================================================================

  setProfile(profile: Profile | null) {
    this._profile.set(profile);
    this._profileLoaded.set(true);
  }

  // ============================================================================
  // CANDIDATES METHODS
  // ============================================================================

  setCandidates(candidates: Candidate[]) {
    this._candidates.set(candidates);
    this._candidatesLoaded.set(true);
    this._candidatesLoading.set(false);

    // Also flatten all resumes
    const allResumes = candidates.flatMap(c => c.resumes || []);
    this._resumes.set(allResumes);
    this._resumesLoaded.set(true);

    // Auto-select first candidate if none selected
    if (!this._selectedCandidateId() && candidates.length > 0) {
      this.selectCandidate(candidates[0].id);
    }
  }

  setCandidatesLoading(loading: boolean) {
    this._candidatesLoading.set(loading);
  }

  invalidateCandidates() {
    this._candidatesLoaded.set(false);
  }

  addCandidate(candidate: Candidate) {
    this._candidates.update(candidates => [...candidates, candidate]);
    // Update resumes
    const allResumes = this._candidates().flatMap(c => c.resumes || []);
    this._resumes.set(allResumes);
  }

  updateCandidate(candidateId: string, updates: Partial<Candidate>) {
    this._candidates.update(candidates =>
      candidates.map(c => c.id === candidateId ? { ...c, ...updates } : c)
    );
    // Update resumes if resumes changed
    if (updates.resumes) {
      const allResumes = this._candidates().flatMap(c => c.resumes || []);
      this._resumes.set(allResumes);
    }
  }

  removeCandidate(candidateId: string) {
    this._candidates.update(candidates => candidates.filter(c => c.id !== candidateId));
    // Update resumes
    const allResumes = this._candidates().flatMap(c => c.resumes || []);
    this._resumes.set(allResumes);
    // Clear selection if deleted candidate was selected
    if (this._selectedCandidateId() === candidateId) {
      const remaining = this._candidates();
      this._selectedCandidateId.set(remaining.length > 0 ? remaining[0].id : '');
    }
  }

  // ============================================================================
  // RESUME METHODS
  // ============================================================================

  addResume(resume: Resume) {
    this._resumes.update(resumes => [...resumes, resume]);
    // Invalidate candidates to trigger reload (resume needs to be grouped)
    this.invalidateCandidates();
  }

  updateResume(resumeId: string, updates: Partial<Resume>) {
    this._resumes.update(resumes =>
      resumes.map(r => r.id === resumeId ? { ...r, ...updates } : r)
    );
    // Also update in candidates
    this._candidates.update(candidates =>
      candidates.map(c => ({
        ...c,
        resumes: c.resumes.map(r => r.id === resumeId ? { ...r, ...updates } : r)
      }))
    );
  }

  removeResume(resumeId: string) {
    this._resumes.update(resumes => resumes.filter(r => r.id !== resumeId));
    // Invalidate candidates to recompute grouping
    this.invalidateCandidates();
    // Clear selection if deleted resume was selected
    if (this._selectedResumeId() === resumeId) {
      this._selectedResumeId.set('');
    }
  }

  // ============================================================================
  // APPLICATIONS METHODS
  // ============================================================================

  setApplications(applications: UserApplicationView[]) {
    this._applications.set(applications);
    this._applicationsLoaded.set(true);
    this._applicationsLoading.set(false);
  }

  setApplicationsLoading(loading: boolean) {
    this._applicationsLoading.set(loading);
  }

  invalidateApplications() {
    this._applicationsLoaded.set(false);
  }

  addApplication(application: UserApplicationView) {
    this._applications.update(apps => [application, ...apps]);
  }

  updateApplication(appId: string, updates: Partial<UserApplicationView>) {
    this._applications.update(apps =>
      apps.map(a => a.id === appId ? { ...a, ...updates } : a)
    );
  }

  removeApplication(appId: string) {
    this._applications.update(apps => apps.filter(a => a.id !== appId));
  }

  // ============================================================================
  // SELECTION METHODS
  // ============================================================================

  selectCandidate(candidateId: string) {
    this._selectedCandidateId.set(candidateId);

    // Auto-select primary resume or first resume for this candidate
    const candidate = this._candidates().find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this._selectedResumeId.set(primary?.id || candidate.resumes[0].id);
    } else {
      this._selectedResumeId.set('');
    }
  }

  selectResume(resumeId: string) {
    this._selectedResumeId.set(resumeId);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get a resume by ID from the cache
   */
  getResumeById(resumeId: string): Resume | null {
    return this._resumes().find(r => r.id === resumeId) || null;
  }

  /**
   * Get a candidate by ID from the cache
   */
  getCandidateById(candidateId: string): Candidate | null {
    return this._candidates().find(c => c.id === candidateId) || null;
  }

  /**
   * Get an application by ID from the cache
   */
  getApplicationById(appId: string): UserApplicationView | null {
    return this._applications().find(a => a.id === appId) || null;
  }

  /**
   * Reset all state (e.g., on logout)
   */
  reset() {
    this._profile.set(null);
    this._profileLoaded.set(false);
    this._candidates.set([]);
    this._candidatesLoaded.set(false);
    this._candidatesLoading.set(false);
    this._resumes.set([]);
    this._resumesLoaded.set(false);
    this._applications.set([]);
    this._applicationsLoaded.set(false);
    this._applicationsLoading.set(false);
    this._selectedCandidateId.set('');
    this._selectedResumeId.set('');
  }
}
