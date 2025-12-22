import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';

@Component({
  selector: 'app-resume-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './resume-manager.component.html',
  styleUrls: ['./resume-manager.component.scss']
})
export class ResumeManagerComponent implements OnInit {
  profile: Profile | null = null;
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
    this.profile = await this.supabase.getProfile();
    if (!this.profile?.organization_id) {
      this.router.navigate(['/setup']);
    }
  }

  async loadResumes() {
    try {
      this.resumes = await this.supabase.getResumes();
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

    try {
      await this.supabase.updateResume(this.selectedResume.id, { label: this.newLabel.trim() });
      this.selectedResume.label = this.newLabel.trim();
      
      // Update in list
      const index = this.resumes.findIndex(r => r.id === this.selectedResume!.id);
      if (index !== -1) {
        this.resumes[index].label = this.newLabel.trim();
      }
      
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

    try {
      await this.supabase.deleteResume(this.resumeToDelete.id);
      this.resumes = this.resumes.filter(r => r.id !== this.resumeToDelete!.id);
      this.cancelDelete();
      
      if (this.selectedResume?.id === this.resumeToDelete.id) {
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