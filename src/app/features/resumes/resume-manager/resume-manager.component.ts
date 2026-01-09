import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { AppStateService } from '../../../core/services/app-state.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

@Component({
  selector: 'app-resume-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent],
  templateUrl: './resume-manager.component.html',
  styleUrls: ['./resume-manager.component.scss']
})
export class ResumeManagerComponent implements OnInit {
  private appState = inject(AppStateService);

  // Use signals from AppStateService
  readonly profile = this.appState.profile;

  // Local resumes array for component state
  resumes: Resume[] = [];
  loading = true;
  uploading = false;

  // View/Edit Modal
  showResumeModal = false;
  selectedResume: Resume | null = null;
  editingLabel = false;
  newLabel = '';

  // Delete confirmation
  showDeleteConfirm = false;
  resumeToDelete: Resume | null = null;

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  async ngOnInit() {
    await this.loadProfile();
    await this.loadResumes();
    this.loading = false;
  }

  async loadProfile() {
    // Check if profile is already loaded in AppStateService
    if (this.appState.profileLoaded()) {
      const profile = this.profile();
      if (!profile?.organization_id) {
        this.router.navigate(['/setup']);
      }
      return;
    }

    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.appState.setProfile(profile);
  }

  async loadResumes() {
    try {
      // Use cached resumes from AppStateService if available
      if (this.appState.resumesLoaded()) {
        this.resumes = this.appState.resumes();
      } else {
        // Load candidates which also populates resumes
        if (!this.appState.candidatesLoaded()) {
          const candidates = await this.supabase.getCandidates();
          this.appState.setCandidates(candidates);
        }
        this.resumes = this.appState.resumes();
      }
    } catch (err) {
      console.error('Failed to load resumes:', err);
    }
  }

  // ============================================================================
  // UPLOAD
  // ============================================================================

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    const extension = file.name.split('.').pop()?.toLowerCase();

    if (!extension || !['pdf', 'docx'].includes(extension)) {
      alert('Please upload a PDF or DOCX file.');
      return;
    }

    this.uploading = true;

    try {
      // Upload file
      const { url } = await this.supabase.uploadResumeFile(file);

      // Create resume record
      const resume = await this.supabase.createResume({
        file_name: file.name,
        file_url: url,
        file_type: file.type,
        extraction_status: 'processing',
        label: this.generateDefaultLabel()
      });

      // Extract with AI
      let extractedData: Partial<Resume>;
      try {
        extractedData = await this.supabase.extractResumeFromUrl(url, file.name);
        extractedData.extraction_status = 'completed';
      } catch (aiError: any) {
        console.error('AI extraction failed:', aiError);
        extractedData = {
          extraction_status: 'failed',
          extraction_confidence: 0
        };
      }

      // Update resume
      const updatedResume = await this.supabase.updateResume(resume.id, extractedData);
      this.resumes.unshift(updatedResume);

      // Invalidate and refresh candidates to include new resume
      this.appState.invalidateCandidates();
      const candidates = await this.supabase.getCandidates();
      this.appState.setCandidates(candidates);

    } catch (err: any) {
      alert('Failed to upload resume: ' + err.message);
    } finally {
      this.uploading = false;
      input.value = '';
    }
  }

  generateDefaultLabel(): string {
    const date = new Date();
    return `Resume ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  // ============================================================================
  // VIEW & EDIT
  // ============================================================================

  viewResume(resume: Resume) {
    this.selectedResume = resume;
    this.newLabel = resume.label || resume.candidate_name || resume.file_name;
    this.showResumeModal = true;
    this.editingLabel = false;
  }

  closeModal() {
    this.showResumeModal = false;
    this.selectedResume = null;
    this.editingLabel = false;
  }

  startEditLabel() {
    this.editingLabel = true;
    this.newLabel = this.selectedResume?.label || this.selectedResume?.candidate_name || '';
  }

  async saveLabel() {
    if (!this.selectedResume || !this.newLabel.trim()) return;

    const resumeId = this.selectedResume.id;
    const newLabel = this.newLabel.trim();

    try {
      await this.supabase.updateResume(resumeId, { label: newLabel });
      this.selectedResume.label = newLabel;

      // Update in local list
      const index = this.resumes.findIndex(r => r.id === resumeId);
      if (index !== -1) {
        this.resumes[index].label = newLabel;
      }

      // Update in AppStateService
      this.appState.updateResume(resumeId, { label: newLabel });

      this.editingLabel = false;
    } catch (err: any) {
      alert('Failed to save label: ' + err.message);
    }
  }

  cancelEditLabel() {
    this.editingLabel = false;
    this.newLabel = this.selectedResume?.label || '';
  }

  // ============================================================================
  // SET PRIMARY
  // ============================================================================

  async setPrimary(resume: Resume) {
    try {
      await this.supabase.setPrimaryResume(resume.id);
      this.resumes.forEach(r => r.is_primary = r.id === resume.id);
    } catch (err: any) {
      alert('Failed to set primary: ' + err.message);
    }
  }

  // ============================================================================
  // DELETE
  // ============================================================================

  confirmDelete(resume: Resume) {
    this.resumeToDelete = resume;
    this.showDeleteConfirm = true;
  }

  cancelDelete() {
    this.resumeToDelete = null;
    this.showDeleteConfirm = false;
  }

  async deleteResume() {
    if (!this.resumeToDelete) return;

    const resumeId = this.resumeToDelete.id;

    try {
      await this.supabase.deleteResume(resumeId);
      this.resumes = this.resumes.filter(r => r.id !== resumeId);

      // Update AppStateService
      this.appState.removeResume(resumeId);

      this.cancelDelete();

      if (this.selectedResume?.id === resumeId) {
        this.closeModal();
      }
    } catch (err: any) {
      alert('Failed to delete resume: ' + err.message);
    }
  }

  // ============================================================================
  // DOWNLOAD & OPEN
  // ============================================================================

  openFile(resume: Resume) {
    if (resume.file_url) {
      window.open(resume.file_url, '_blank');
    }
  }

  downloadFile(resume: Resume) {
    if (!resume.file_url) return;
    
    const link = document.createElement('a');
    link.href = resume.file_url;
    link.target = '_blank';
    link.download = resume.file_name || 'resume';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ============================================================================
  // NAVIGATION
  // ============================================================================

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  goToAnalyzer(resume: Resume) {
    this.router.navigate(['/analyzer'], { queryParams: { resumeId: resume.id } });
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  getDisplayName(resume: Resume): string {
    return resume.label || resume.candidate_name || resume.file_name;
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'completed': return 'status-success';
      case 'processing': return 'status-processing';
      case 'failed': return 'status-failed';
      default: return '';
    }
  }

  getStatusText(status: string): string {
    switch (status) {
      case 'completed': return 'Extracted';
      case 'processing': return 'Processing...';
      case 'failed': return 'Failed';
      default: return 'Pending';
    }
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
}