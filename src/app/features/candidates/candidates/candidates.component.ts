import { CommonModule } from '@angular/common';
import { Component, OnInit, Input, inject, computed, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Candidate, CandidateDocument, CandidatePreferences, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { AppStateService } from '../../../core/services/app-state.service';
import { VendorEmailService } from '../../../core/services/vendor-email.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

// PrimeNG imports
import { TableModule, Table } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';

@Component({
  selector: 'app-candidates',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SidebarComponent,
    TableModule,
    MultiSelectModule,
    TagModule
  ],
  templateUrl: './candidates.component.html',
  styleUrl: './candidates.component.scss'
})
export class CandidatesComponent implements OnInit {
  @ViewChild('dt') dt!: Table;
  @Input() embedded = false;

  private appState = inject(AppStateService);

  // Use signals from AppStateService
  readonly profile = this.appState.profile;
  readonly isAdmin = this.appState.isAdmin;

  // Local candidates - can be different from appState for admin view
  candidates: Candidate[] = [];
  loading = true;
  searchTerm = '';
  skillFilter = '';

  // PrimeNG Table
  expandedRows: { [key: string]: boolean } = {};
  sortField: string = '';
  sortOrder: number = 0;

  // Filter options
  companyOptions: { label: string; value: string }[] = [];
  locationOptions: { label: string; value: string }[] = [];
  selectedCompanies: string[] = [];
  selectedLocations: string[] = [];

  // Expandable rows (legacy)
  expandedCandidateId: string | null = null;

  // Modal
  showCandidateModal = false;
  selectedCandidate: Candidate | null = null;
  selectedResume: Resume | null = null;

  // Active tab in modal
  activeTab: 'overview' | 'preferences' | 'documents' = 'overview';

  // Preferences editing
  editingPreferences = false;
  savingPreferences = false;
  editedPreferences: Partial<CandidatePreferences> = {};

  // Documents
  candidateDocuments: CandidateDocument[] = [];
  loadingDocuments = false;
  uploadingDocument = false;
  newDocumentType: CandidateDocument['document_type'] = 'other';
  newDocumentName = '';
  newDocumentExpiry = '';
  newDocumentNotes = '';

  // Document type options
  documentTypes: { value: CandidateDocument['document_type']; label: string }[] = [
    { value: 'drivers_license', label: 'Driver\'s License' },
    { value: 'passport', label: 'Passport' },
    { value: 'id_card', label: 'ID Card' },
    { value: 'certification', label: 'Certification' },
    { value: 'degree', label: 'Degree/Diploma' },
    { value: 'reference', label: 'Reference Letter' },
    { value: 'portfolio', label: 'Portfolio' },
    { value: 'other', label: 'Other' }
  ];

  // Work type options
  workTypeOptions = ['remote', 'hybrid', 'onsite'];
  companySizeOptions = ['startup', 'small', 'medium', 'large', 'enterprise'];

  // Resume management
  uploading = false;
  showDeleteResumeConfirm = false;
  resumeToDelete: Resume | null = null;

  // Skills expand state per candidate
  skillsExpandedMap: { [candidateId: string]: boolean } = {};
  skillsVisibleCount = 12;

  // Stats
  stats = {
    totalCandidates: 0,
    totalResumes: 0,
    totalSkills: 0
  };

  // Gmail / Email integration (per-candidate state)
  private vendorEmailService = inject(VendorEmailService);
  gmailState: { [candidateId: string]: {
    accounts: any[];
    loading: boolean;
    syncing: boolean;
    loaded: boolean;
  } } = {};

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

  async loadCandidates() {
    try {
      // Use org-level for admin, user-level otherwise
      if (this.isAdmin()) {
        // Admin sees all org candidates - load fresh
        this.candidates = await this.supabase.getAllCandidatesForOrg();
      } else {
        // Regular users - use cached state if available
        if (this.appState.candidatesLoaded()) {
          this.candidates = this.appState.candidates();
        } else {
          const candidates = await this.supabase.getCandidates();
          this.appState.setCandidates(candidates);
          this.candidates = candidates;
        }
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

    // Count unique skills across all candidates
    const skillSet = new Set<string>();
    this.candidates.forEach(c => {
      c.skills?.forEach(s => skillSet.add(s.name.toLowerCase()));
    });
    this.stats.totalSkills = skillSet.size;

    this.buildFilterOptions();
  }

  buildFilterOptions() {
    const companies = new Set<string>();
    const locations = new Set<string>();
    this.candidates.forEach(c => {
      if (c.current_company) companies.add(c.current_company);
      if (c.location) locations.add(c.location);
    });
    this.companyOptions = Array.from(companies).sort().map(c => ({ label: c, value: c }));
    this.locationOptions = Array.from(locations).sort().map(l => ({ label: l, value: l }));
  }

  onSort(event: Event, field: string) {
    if (this.sortField === field) {
      this.sortOrder = this.sortOrder === 1 ? -1 : 0;
    } else {
      this.sortField = field;
      this.sortOrder = 1;
    }

    if (this.sortOrder !== 0) {
      this.dt.sortField = this.sortField;
      this.dt.sortOrder = this.sortOrder;
      this.dt.sortSingle();
    } else {
      this.sortField = '';
      this.dt.reset();
      if (this.searchTerm) this.dt.filterGlobal(this.searchTerm, 'contains');
      if (this.selectedCompanies.length) this.dt.filter(this.selectedCompanies, 'current_company', 'in');
      if (this.selectedLocations.length) this.dt.filter(this.selectedLocations, 'location', 'in');
    }
  }

  getSortIcon(field: string): string {
    if (this.sortField !== field || this.sortOrder === 0) return 'pi-sort-alt';
    return this.sortOrder === 1 ? 'pi-sort-amount-up-alt' : 'pi-sort-amount-down';
  }

  onGlobalFilter(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.dt.filterGlobal(value, 'contains');
  }

  clearFilters() {
    this.dt.clear();
    this.searchTerm = '';
    this.selectedCompanies = [];
    this.selectedLocations = [];
    this.sortField = '';
    this.sortOrder = 0;
  }

  onCompanyFilterChange() {
    if (this.selectedCompanies.length > 0) {
      this.dt.filter(this.selectedCompanies, 'current_company', 'in');
    } else {
      this.dt.filter(null, 'current_company', 'in');
    }
  }

  onLocationFilterChange() {
    if (this.selectedLocations.length > 0) {
      this.dt.filter(this.selectedLocations, 'location', 'in');
    } else {
      this.dt.filter(null, 'location', 'in');
    }
  }

  getExperienceSeverity(level: string | null): 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast' | undefined {
    if (!level) return undefined;
    const l = level.toLowerCase();
    if (l.includes('senior') || l.includes('lead') || l.includes('principal')) return 'success';
    if (l.includes('mid') || l.includes('intermediate')) return 'info';
    if (l.includes('junior') || l.includes('entry')) return 'warning';
    return 'secondary';
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

  async viewCandidate(candidate: Candidate) {
    this.selectedCandidate = candidate;
    this.selectedResume = candidate.resumes[0] || null;
    this.activeTab = 'overview';
    this.showCandidateModal = true;

    // Load documents for this candidate
    await this.loadCandidateDocuments(candidate.id);

    // Initialize preferences editing with existing or default values
    this.initializePreferencesForm(candidate.preferences);
  }

  async loadCandidateDocuments(candidateId: string) {
    this.loadingDocuments = true;
    try {
      this.candidateDocuments = await this.supabase.getCandidateDocuments(candidateId);
    } catch (err) {
      console.error('Failed to load documents:', err);
      this.candidateDocuments = [];
    } finally {
      this.loadingDocuments = false;
    }
  }

  initializePreferencesForm(preferences: CandidatePreferences | null) {
    this.editedPreferences = preferences ? { ...preferences } : {
      preferred_job_titles: [],
      preferred_locations: [],
      willing_to_relocate: false,
      preferred_work_type: [],
      preferred_company_size: [],
      preferred_industries: [],
      salary_expectation_min: null,
      salary_expectation_max: null,
      salary_currency: 'USD',
      available_start_date: null,
      notice_period_days: null,
      visa_status: null,
      work_authorization: null,
      has_drivers_license: false,
      willing_to_travel: false,
      travel_percentage: null,
      notes: null
    };
    this.editingPreferences = false;
  }

  selectResume(resume: Resume) {
    this.selectedResume = resume;
  }

  setActiveTab(tab: 'overview' | 'preferences' | 'documents') {
    this.activeTab = tab;
  }

  closeCandidateModal() {
    this.showCandidateModal = false;
    this.selectedCandidate = null;
    this.selectedResume = null;
    this.candidateDocuments = [];
    this.editingPreferences = false;
    this.activeTab = 'overview';
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

  // ============================================================================
  // PREFERENCES
  // ============================================================================

  startEditingPreferences() {
    this.editingPreferences = true;
  }

  cancelEditingPreferences() {
    if (this.selectedCandidate) {
      this.initializePreferencesForm(this.selectedCandidate.preferences);
    }
  }

  async savePreferences() {
    if (!this.selectedCandidate) return;

    this.savingPreferences = true;
    try {
      const savedPrefs = await this.supabase.saveCandidatePreferences(
        this.selectedCandidate.id,
        this.editedPreferences
      );

      // Update local state
      this.selectedCandidate.preferences = savedPrefs;
      this.editingPreferences = false;

      // Update in candidates list
      const idx = this.candidates.findIndex(c => c.id === this.selectedCandidate!.id);
      if (idx >= 0) {
        this.candidates[idx].preferences = savedPrefs;
      }
    } catch (err: any) {
      console.error('Failed to save preferences:', err);
      alert('Failed to save preferences: ' + err.message);
    } finally {
      this.savingPreferences = false;
    }
  }

  // Preferences array helpers
  toggleWorkType(type: string) {
    const arr = this.editedPreferences.preferred_work_type || [];
    const idx = arr.indexOf(type as any);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(type as any);
    }
    this.editedPreferences.preferred_work_type = [...arr];
  }

  isWorkTypeSelected(type: string): boolean {
    return (this.editedPreferences.preferred_work_type || []).includes(type as any);
  }

  toggleCompanySize(size: string) {
    const arr = this.editedPreferences.preferred_company_size || [];
    const idx = arr.indexOf(size as any);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(size as any);
    }
    this.editedPreferences.preferred_company_size = [...arr];
  }

  isCompanySizeSelected(size: string): boolean {
    return (this.editedPreferences.preferred_company_size || []).includes(size as any);
  }

  addPreferredJobTitle(event: Event) {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (value && !this.editedPreferences.preferred_job_titles?.includes(value)) {
      this.editedPreferences.preferred_job_titles = [
        ...(this.editedPreferences.preferred_job_titles || []),
        value
      ];
      input.value = '';
    }
  }

  removePreferredJobTitle(title: string) {
    this.editedPreferences.preferred_job_titles = (this.editedPreferences.preferred_job_titles || [])
      .filter(t => t !== title);
  }

  addPreferredLocation(event: Event) {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (value && !this.editedPreferences.preferred_locations?.includes(value)) {
      this.editedPreferences.preferred_locations = [
        ...(this.editedPreferences.preferred_locations || []),
        value
      ];
      input.value = '';
    }
  }

  removePreferredLocation(location: string) {
    this.editedPreferences.preferred_locations = (this.editedPreferences.preferred_locations || [])
      .filter(l => l !== location);
  }

  addPreferredIndustry(event: Event) {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (value && !this.editedPreferences.preferred_industries?.includes(value)) {
      this.editedPreferences.preferred_industries = [
        ...(this.editedPreferences.preferred_industries || []),
        value
      ];
      input.value = '';
    }
  }

  removePreferredIndustry(industry: string) {
    this.editedPreferences.preferred_industries = (this.editedPreferences.preferred_industries || [])
      .filter(i => i !== industry);
  }

  // ============================================================================
  // DOCUMENTS
  // ============================================================================

  async onDocumentFileSelected(event: Event) {
    if (!this.selectedCandidate) return;

    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (file.size > maxSize) {
      alert('File size must be less than 10MB');
      input.value = '';
      return;
    }

    this.uploadingDocument = true;

    try {
      // Upload file
      const { url } = await this.supabase.uploadCandidateDocument(file, this.selectedCandidate.id);

      // Create document record
      const doc = await this.supabase.createCandidateDocument({
        candidate_id: this.selectedCandidate.id,
        document_type: this.newDocumentType,
        document_name: this.newDocumentName || this.getDocumentTypeLabel(this.newDocumentType),
        file_name: file.name,
        file_url: url,
        file_type: file.type,
        file_size: file.size,
        expiry_date: this.newDocumentExpiry || null,
        notes: this.newDocumentNotes || null
      });

      // Add to local list
      this.candidateDocuments = [doc, ...this.candidateDocuments];

      // Reset form
      this.newDocumentType = 'other';
      this.newDocumentName = '';
      this.newDocumentExpiry = '';
      this.newDocumentNotes = '';

    } catch (err: any) {
      console.error('Failed to upload document:', err);
      alert('Failed to upload document: ' + err.message);
    } finally {
      this.uploadingDocument = false;
      input.value = '';
    }
  }

  getDocumentTypeLabel(type: CandidateDocument['document_type']): string {
    const found = this.documentTypes.find(dt => dt.value === type);
    return found?.label || type;
  }

  getDocumentIcon(type: CandidateDocument['document_type']): string {
    const icons: Record<CandidateDocument['document_type'], string> = {
      drivers_license: '🚗',
      passport: '🛂',
      id_card: '🪪',
      certification: '📜',
      degree: '🎓',
      reference: '📝',
      portfolio: '💼',
      other: '📎'
    };
    return icons[type] || '📎';
  }

  async openDocument(doc: CandidateDocument) {
    if (!doc.file_url) return;

    try {
      // Get a signed URL for the private bucket
      const signedUrl = await this.supabase.getSignedDocumentUrl(doc.file_url);
      window.open(signedUrl, '_blank');
    } catch (err: any) {
      console.error('Failed to get document URL:', err);
      alert('Failed to open document: ' + err.message);
    }
  }

  async deleteDocument(doc: CandidateDocument) {
    if (!confirm(`Delete "${doc.document_name}"?`)) return;

    try {
      await this.supabase.deleteCandidateDocument(doc.id);
      this.candidateDocuments = this.candidateDocuments.filter(d => d.id !== doc.id);
    } catch (err: any) {
      console.error('Failed to delete document:', err);
      alert('Failed to delete document: ' + err.message);
    }
  }

  isDocumentExpired(doc: CandidateDocument): boolean {
    if (!doc.expiry_date) return false;
    return new Date(doc.expiry_date) < new Date();
  }

  isDocumentExpiringSoon(doc: CandidateDocument): boolean {
    if (!doc.expiry_date) return false;
    const expiryDate = new Date(doc.expiry_date);
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    return expiryDate > new Date() && expiryDate <= thirtyDaysFromNow;
  }

  formatFileSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  getProficiencyClass(proficiency: string | undefined): string {
    if (!proficiency) return '';
    const p = proficiency.toLowerCase();
    if (p === 'expert') return 'proficiency-expert';
    if (p === 'advanced') return 'proficiency-advanced';
    if (p === 'intermediate') return 'proficiency-intermediate';
    return '';
  }

  getSkillsByProficiency(candidate: Candidate, level: string): { name: string; proficiency?: string }[] {
    if (!candidate.skills?.length) return [];
    return candidate.skills.filter(s => (s.proficiency || '').toLowerCase() === level.toLowerCase());
  }

  getVisibleSkillsByProficiency(candidate: Candidate, level: string): { name: string; proficiency?: string }[] {
    if (this.skillsExpandedMap[candidate.id]) {
      return this.getSkillsByProficiency(candidate, level);
    }
    // When collapsed, show up to skillsVisibleCount total across all groups
    const expert = this.getSkillsByProficiency(candidate, 'expert');
    const advanced = this.getSkillsByProficiency(candidate, 'advanced');
    const intermediate = this.getSkillsByProficiency(candidate, 'intermediate');

    let remaining = this.skillsVisibleCount;
    if (level === 'expert') {
      return expert.slice(0, remaining);
    }
    remaining -= expert.length;
    if (level === 'advanced') {
      return remaining > 0 ? advanced.slice(0, remaining) : [];
    }
    remaining -= advanced.length;
    if (level === 'intermediate') {
      return remaining > 0 ? intermediate.slice(0, remaining) : [];
    }
    return [];
  }

  toggleSkillsExpanded(candidateId: string) {
    this.skillsExpandedMap[candidateId] = !this.skillsExpandedMap[candidateId];
  }

  isSkillsExpanded(candidateId: string): boolean {
    return !!this.skillsExpandedMap[candidateId];
  }

  getExperienceBadgeClass(level: string | null): string {
    if (!level) return '';
    const l = level.toLowerCase();
    if (l.includes('senior') || l.includes('lead') || l.includes('principal')) return 'exp-senior';
    if (l.includes('mid') || l.includes('intermediate')) return 'exp-mid';
    if (l.includes('junior') || l.includes('entry')) return 'exp-junior';
    return '';
  }

  // ============================================================================
  // RESUME MANAGEMENT
  // ============================================================================

  async onResumeFileSelected(event: Event) {
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
      const { url } = await this.supabase.uploadResumeFile(file);

      const resume = await this.supabase.createResume({
        file_name: file.name,
        file_url: url,
        file_type: file.type,
        extraction_status: 'processing',
        label: this.generateDefaultLabel()
      });

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

      await this.supabase.updateResume(resume.id, extractedData);

      // Invalidate and refresh candidates
      this.appState.invalidateCandidates();
      const candidates = await this.supabase.getCandidates();
      this.appState.setCandidates(candidates);
      this.candidates = candidates;
      this.calculateStats();

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

  async setResumePrimary(resume: Resume) {
    try {
      await this.supabase.setPrimaryResume(resume.id);
      // Update in local candidate's resumes
      const candidate = this.candidates.find(c => c.resumes.some(r => r.id === resume.id));
      if (candidate) {
        candidate.resumes.forEach(r => r.is_primary = r.id === resume.id);
      }
      if (this.selectedCandidate) {
        this.selectedCandidate.resumes.forEach(r => r.is_primary = r.id === resume.id);
      }
    } catch (err: any) {
      alert('Failed to set primary: ' + err.message);
    }
  }

  confirmDeleteResume(resume: Resume) {
    this.resumeToDelete = resume;
    this.showDeleteResumeConfirm = true;
  }

  cancelDeleteResume() {
    this.resumeToDelete = null;
    this.showDeleteResumeConfirm = false;
  }

  async executeDeleteResume() {
    if (!this.resumeToDelete) return;

    const resumeId = this.resumeToDelete.id;

    try {
      await this.supabase.deleteResume(resumeId);

      // Remove from local candidate's resumes
      for (const candidate of this.candidates) {
        candidate.resumes = candidate.resumes.filter(r => r.id !== resumeId);
        candidate.resume_count = candidate.resumes.length;
      }

      if (this.selectedCandidate) {
        this.selectedCandidate.resumes = this.selectedCandidate.resumes.filter(r => r.id !== resumeId);
        this.selectedCandidate.resume_count = this.selectedCandidate.resumes.length;
        if (this.selectedResume?.id === resumeId) {
          this.selectedResume = this.selectedCandidate.resumes[0] || null;
        }
      }

      this.appState.removeResume(resumeId);
      this.cancelDeleteResume();
      this.calculateStats();
    } catch (err: any) {
      alert('Failed to delete resume: ' + err.message);
    }
  }

  goToAnalyzer(resume: Resume) {
    this.router.navigate(['/analyzer'], { queryParams: { resumeId: resume.id } });
  }

  getResumeDisplayName(resume: Resume): string {
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

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  onRowExpand(event: any) {
    const candidate = event.data;
    if (candidate?.id) {
      this.loadCandidateGmail(candidate.id);
    }
  }

  // ============================================================================
  // CANDIDATE EMAIL / GMAIL (per-candidate)
  // ============================================================================

  private getGmailState(candidateId: string) {
    if (!this.gmailState[candidateId]) {
      this.gmailState[candidateId] = { accounts: [], loading: false, syncing: false, loaded: false };
    }
    return this.gmailState[candidateId];
  }

  async loadCandidateGmail(candidateId: string) {
    const state = this.getGmailState(candidateId);
    if (state.loaded || state.loading) return;

    state.loading = true;
    try {
      const accounts = await this.vendorEmailService.getCandidateGmailAccounts(candidateId);
      state.accounts = accounts;
      state.loaded = true;
    } catch (err) {
      console.error('Failed to load Gmail accounts:', err);
    } finally {
      state.loading = false;
    }
  }

  async connectCandidateGmail(candidateId: string) {
    const state = this.getGmailState(candidateId);
    if (state.accounts.length >= 3) {
      alert('Maximum of 3 Gmail accounts per candidate. Please disconnect one to add another.');
      return;
    }

    try {
      const { authUrl } = await this.vendorEmailService.getGmailAuthUrl(candidateId);
      sessionStorage.setItem('gmail_oauth_candidate_id', candidateId);
      window.location.href = authUrl;
    } catch (err: any) {
      console.error('Failed to start Gmail OAuth:', err);
      alert('Failed to connect Gmail: ' + err.message);
    }
  }

  async disconnectGmailAccount(candidateId: string, connectionId: string, email: string) {
    if (!confirm(`Disconnect ${email}? Synced jobs will be kept.`)) return;

    try {
      const success = await this.vendorEmailService.disconnectGmailConnection(connectionId);
      if (success) {
        const state = this.getGmailState(candidateId);
        state.accounts = state.accounts.filter((a: any) => a.connection_id !== connectionId);
      }
    } catch (err: any) {
      console.error('Failed to disconnect Gmail:', err);
      alert('Failed to disconnect: ' + err.message);
    }
  }

  async syncGmailAccount(candidateId: string, connectionId: string) {
    const state = this.getGmailState(candidateId);
    state.syncing = true;

    try {
      const result = await this.vendorEmailService.syncGmailConnection(connectionId);
      if (result.jobsCreated > 0) {
        console.log(`Synced ${result.emailsParsed} emails, found ${result.jobsCreated} new jobs`);
      }
      // Reload accounts
      state.loaded = false;
      await this.loadCandidateGmail(candidateId);
    } catch (err: any) {
      console.error('Failed to sync emails:', err);
      alert('Failed to sync emails: ' + err.message);
    } finally {
      state.syncing = false;
    }
  }
}
