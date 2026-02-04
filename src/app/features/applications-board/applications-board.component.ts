import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MultiSelectModule } from 'primeng/multiselect';
import { DropdownModule } from 'primeng/dropdown';
import { CalendarModule } from 'primeng/calendar';
import { ToastModule } from 'primeng/toast';
import { SliderModule } from 'primeng/slider';
import { MessageService } from 'primeng/api';
import { UserApplicationView, ApplicationStatus, Resume } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';
import { InterviewService, ScheduledInterview } from '../../core/services/interview.service';
import {SidebarComponent} from '../../shared/sidebar/sidebar.component';

interface ApplicationWithInterview extends UserApplicationView {
  scheduledInterviews?: ScheduledInterview[];
  candidateName?: string;
  candidateEmail?: string;
}

@Component({
  selector: 'app-applications-board',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MultiSelectModule,
    DropdownModule,
    CalendarModule,
    ToastModule,
    SliderModule,
    SidebarComponent,
  ],
  providers: [MessageService],
  templateUrl: './applications-board.component.html',
  styleUrl: './applications-board.component.scss',
})
export class ApplicationsBoardComponent implements OnInit {
  private router = inject(Router);
  private supabase = inject(SupabaseService);
  private interviewService = inject(InterviewService);
  private messageService = inject(MessageService);

  // State signals
  loading = signal(false);
  applications = signal<ApplicationWithInterview[]>([]);
  interviews = signal<ScheduledInterview[]>([]);
  resumes = signal<Resume[]>([]);

  // View mode: 'kanban' or 'table'
  viewMode = signal<'table' | 'kanban'>('kanban');

  // Expanded groups in table view
  expandedGroups = signal<Set<string>>(new Set());

  // Selected applications for bulk operations
  selectedApplications = signal<Set<string>>(new Set());

  // Application detail sidebar
  selectedApplication = signal<ApplicationWithInterview | null>(null);
  showSidebar = signal(false);

  // Drag state
  draggedApp = signal<ApplicationWithInterview | null>(null);
  dragOverColumn = signal<string | null>(null);

  // Search and filter
  searchQuery = '';

  // Filter options
  statusOptions = [
    { label: 'Extracted', value: 'extracted' },
    { label: 'Applied', value: 'applied' },
    { label: 'Screening', value: 'screening' },
    { label: 'Interviewing', value: 'interviewing' },
    { label: 'Offer', value: 'offer' },
    { label: 'Accepted', value: 'accepted' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'Withdrawn', value: 'withdrawn' },
  ];

  workTypeOptions = [
    { label: 'Remote', value: 'remote' },
    { label: 'Hybrid', value: 'hybrid' },
    { label: 'On-site', value: 'onsite' },
  ];

  experienceLevelOptions = [
    { label: 'Entry Level', value: 'entry' },
    { label: 'Mid Level', value: 'mid' },
    { label: 'Senior', value: 'senior' },
    { label: 'Lead', value: 'lead' },
    { label: 'Executive', value: 'executive' },
  ];

  // Selected filter values
  selectedStatuses: string[] = [];
  selectedWorkTypes: string[] = [];
  selectedExperienceLevels: string[] = [];
  dateRange: Date[] = [];
  salaryRange: number[] = [0, 300000]; // Default range 0 to 300k
  salaryFilterActive = false;

  // Sorting
  sortField = '';
  sortOrder = 1;

  // Kanban columns - Application Pipeline
  applicationStatuses: Array<{id: ApplicationStatus, label: string, icon: string, color: string}> = [
    { id: 'extracted', label: 'Extracted', icon: '📄', color: '#6b7280' },
    { id: 'applied', label: 'Applied', icon: '📤', color: '#3b82f6' },
    { id: 'interviewing', label: 'Interviewing', icon: '👥', color: '#f59e0b' },
    { id: 'offer', label: 'Offer', icon: '🎉', color: '#22c55e' },
  ];

  // All statuses including terminal ones
  allStatuses: Array<{id: ApplicationStatus, label: string, icon: string, color: string}> = [
    { id: 'extracted', label: 'Extracted', icon: '📄', color: '#6b7280' },
    { id: 'applied', label: 'Applied', icon: '📤', color: '#3b82f6' },
    { id: 'screening', label: 'Screening', icon: '🔍', color: '#8b5cf6' },
    { id: 'interviewing', label: 'Interviewing', icon: '👥', color: '#f59e0b' },
    { id: 'offer', label: 'Offer', icon: '🎉', color: '#22c55e' },
    { id: 'accepted', label: 'Accepted', icon: '✅', color: '#10b981' },
    { id: 'rejected', label: 'Rejected', icon: '❌', color: '#ef4444' },
    { id: 'withdrawn', label: 'Withdrawn', icon: '↩️', color: '#9ca3af' },
  ];

  // Unique positions computed from applications
  positionOptions = computed(() => {
    const positions = new Set<string>();
    this.applications().forEach(app => {
      if (app.job_title) positions.add(app.job_title);
    });
    return Array.from(positions).map(p => ({ label: p, value: p }));
  });

  // Unique skills computed from applications
  skillOptions = computed(() => {
    const skills = new Set<string>();
    this.applications().forEach(app => {
      app.matching_skills?.forEach(s => skills.add(s));
      app.missing_skills?.forEach(s => skills.add(s));
    });
    return Array.from(skills).map(s => ({ label: s, value: s }));
  });

  selectedPositions: string[] = [];
  selectedSkills: string[] = [];

  ngOnInit(): void {
    this.loadData();
  }

  async loadData(): Promise<void> {
    this.loading.set(true);
    try {
      // Load applications and resumes in parallel
      const [apps, resumes] = await Promise.all([
        this.supabase.getApplicationsWithDetails(),
        this.supabase.getResumes()
      ]);

      this.resumes.set(resumes);

      // Create a map of resume_id -> candidate info
      const resumeMap = new Map<string, { name: string; email?: string }>();
      resumes.forEach(resume => {
        resumeMap.set(resume.id, {
          name: resume.candidate_name || 'Unknown Candidate',
          email: resume.candidate_email || undefined
        });
      });

      // Link candidate info to applications
      const appsWithCandidate = apps.map(app => {
        const resumeInfo = app.resume_id ? resumeMap.get(app.resume_id) : null;
        return {
          ...app,
          candidateName: resumeInfo?.name || 'Unknown Candidate',
          candidateEmail: resumeInfo?.email
        };
      }) as ApplicationWithInterview[];

      this.applications.set(appsWithCandidate);

      // Load interviews after applications are set
      await this.loadInterviews();
    } catch (error) {
      console.error('Error loading data:', error);
      this.showError('Failed to load applications');
    } finally {
      this.loading.set(false);
    }
  }

  async loadInterviews(): Promise<void> {
    try {
      const interviews = await this.interviewService.getInterviews();
      this.interviews.set(interviews);

      // Link interviews to applications
      const interviewsByApp = new Map<string, ScheduledInterview[]>();
      interviews.forEach(interview => {
        if (!interviewsByApp.has(interview.application_id)) {
          interviewsByApp.set(interview.application_id, []);
        }
        interviewsByApp.get(interview.application_id)!.push(interview);
      });

      // Update applications with their interviews
      const updatedApps = this.applications().map(app => ({
        ...app,
        scheduledInterviews: interviewsByApp.get(app.id) || []
      }));
      this.applications.set(updatedApps);
    } catch (error) {
      console.error('Error loading interviews:', error);
    }
  }

  // View mode methods
  setViewMode(mode: 'kanban' | 'table'): void {
    this.viewMode.set(mode);
  }

  // Filter methods
  getFilteredApplications(): ApplicationWithInterview[] {
    let filtered = this.applications();

    // Search query
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase().trim();
      filtered = filtered.filter(app =>
        app.job_title?.toLowerCase().includes(query) ||
        app.company_name?.toLowerCase().includes(query) ||
        app.location?.toLowerCase().includes(query) ||
        app.matching_skills?.some(s => s.toLowerCase().includes(query))
      );
    }

    // Status filter
    if (this.selectedStatuses.length > 0) {
      filtered = filtered.filter(app => this.selectedStatuses.includes(app.status));
    }

    // Position filter
    if (this.selectedPositions.length > 0) {
      filtered = filtered.filter(app =>
        app.job_title && this.selectedPositions.includes(app.job_title)
      );
    }

    // Skills filter
    if (this.selectedSkills.length > 0) {
      filtered = filtered.filter(app =>
        app.matching_skills?.some(s => this.selectedSkills.includes(s))
      );
    }

    // Work type filter
    if (this.selectedWorkTypes.length > 0) {
      filtered = filtered.filter(app =>
        app.work_type && this.selectedWorkTypes.includes(app.work_type.toLowerCase())
      );
    }

    // Experience level filter
    if (this.selectedExperienceLevels.length > 0) {
      filtered = filtered.filter(app =>
        app.experience_level && this.selectedExperienceLevels.includes(app.experience_level.toLowerCase())
      );
    }

    // Date range filter
    if (this.dateRange.length === 2 && this.dateRange[0] && this.dateRange[1]) {
      const startDate = this.dateRange[0].getTime();
      const endDate = this.dateRange[1].getTime();
      filtered = filtered.filter(app => {
        const appliedDate = new Date(app.applied_at).getTime();
        return appliedDate >= startDate && appliedDate <= endDate;
      });
    }

    // Salary range filter
    if (this.salaryFilterActive) {
      filtered = filtered.filter(app => {
        // Use the max salary if available, otherwise use min salary
        const appSalary = app.salary_max ?? app.salary_min;

        // Include apps with null salary if min is at 0
        if (appSalary === null || appSalary === undefined) {
          return this.salaryRange[0] === 0;
        }

        return appSalary >= this.salaryRange[0] && appSalary <= this.salaryRange[1];
      });
    }

    return filtered;
  }

  getFilteredApplicationsByStatus(status: ApplicationStatus): ApplicationWithInterview[] {
    return this.getFilteredApplications().filter(app => app.status === status);
  }

  getApplicationsByStatus(status: ApplicationStatus): ApplicationWithInterview[] {
    return this.applications().filter(app => app.status === status);
  }

  // Grouping for table view - by candidate name
  getApplicationsGroupedByCandidate(): { candidateName: string; candidateEmail?: string; applications: ApplicationWithInterview[] }[] {
    const filtered = this.getFilteredApplications();
    const groupMap = new Map<string, { candidateName: string; candidateEmail?: string; applications: ApplicationWithInterview[] }>();

    filtered.forEach(app => {
      const candidateName = app.candidateName || 'Unknown Candidate';
      const key = candidateName;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          candidateName,
          candidateEmail: app.candidateEmail,
          applications: []
        });
      }
      groupMap.get(key)!.applications.push(app);
    });

    // Sort groups alphabetically by candidate name
    const groups = Array.from(groupMap.values());
    groups.sort((a, b) => a.candidateName.localeCompare(b.candidateName));

    groups.forEach(group => {
      group.applications = this.sortApplicationsInGroup(group.applications);
    });

    return groups;
  }

  sortApplicationsInGroup(apps: ApplicationWithInterview[]): ApplicationWithInterview[] {
    if (this.sortField) {
      return [...apps].sort((a, b) => {
        let valueA: any;
        let valueB: any;

        switch (this.sortField) {
          case 'status':
            const statusOrder: Record<string, number> = {
              'extracted': 0, 'applied': 1, 'screening': 2, 'interviewing': 3,
              'offer': 4, 'accepted': 5, 'rejected': 6, 'withdrawn': 7
            };
            valueA = statusOrder[a.status] ?? 99;
            valueB = statusOrder[b.status] ?? 99;
            break;
          case 'applied_at':
            valueA = new Date(a.applied_at).getTime();
            valueB = new Date(b.applied_at).getTime();
            break;
          case 'match_score':
            valueA = a.match_score ?? 0;
            valueB = b.match_score ?? 0;
            break;
          case 'company_name':
            valueA = a.company_name || '';
            valueB = b.company_name || '';
            break;
          default:
            valueA = (a as any)[this.sortField] || '';
            valueB = (b as any)[this.sortField] || '';
        }

        if (typeof valueA === 'string') {
          return this.sortOrder * valueA.localeCompare(valueB);
        }
        return this.sortOrder * (valueA - valueB);
      });
    }

    // Default: sort by applied_at descending
    return [...apps].sort((a, b) =>
      new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime()
    );
  }

  // Native Drag and Drop
  onDragStart(event: DragEvent, app: ApplicationWithInterview): void {
    this.draggedApp.set(app);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', app.id);
    }
    // Add dragging class to card
    const target = event.target as HTMLElement;
    target.classList.add('dragging');
  }

  onDragEnd(event: DragEvent): void {
    this.draggedApp.set(null);
    this.dragOverColumn.set(null);
    const target = event.target as HTMLElement;
    target.classList.remove('dragging');
  }

  onDragOver(event: DragEvent, status: ApplicationStatus): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dragOverColumn.set(status);
  }

  onDragLeave(event: DragEvent): void {
    this.dragOverColumn.set(null);
  }

  async onDrop(event: DragEvent, newStatus: ApplicationStatus): Promise<void> {
    event.preventDefault();
    this.dragOverColumn.set(null);

    const app = this.draggedApp();
    if (!app || app.status === newStatus) {
      this.draggedApp.set(null);
      return;
    }

    const originalStatus = app.status;

    // Optimistically update UI
    const updatedApps = this.applications().map(a =>
      a.id === app.id ? { ...a, status: newStatus } : a
    );
    this.applications.set(updatedApps);

    try {
      await this.supabase.updateApplication(app.id, { status: newStatus });
      this.showSuccess(`Application moved to ${this.getStatusLabel(newStatus)}`);
    } catch (error) {
      // Revert on error
      const revertedApps = this.applications().map(a =>
        a.id === app.id ? { ...a, status: originalStatus } : a
      );
      this.applications.set(revertedApps);
      this.showError('Failed to update application status');
      console.error('Error updating status:', error);
    } finally {
      this.draggedApp.set(null);
    }
  }

  // Column helpers
  getColumnClass(status: ApplicationStatus): string {
    switch (status) {
      case 'extracted': return 'extracted';
      case 'applied': return 'applied';
      case 'interviewing': return 'interviewing';
      case 'offer': return 'offer';
      default: return '';
    }
  }

  getStatusLabel(status: ApplicationStatus): string {
    const found = this.allStatuses.find(s => s.id === status);
    return found?.label || status;
  }

  getStatusColor(status: ApplicationStatus): string {
    const found = this.allStatuses.find(s => s.id === status);
    return found?.color || '#6b7280';
  }

  getStatusIcon(status: ApplicationStatus): string {
    const found = this.allStatuses.find(s => s.id === status);
    return found?.icon || '📄';
  }

  getColumnCount(status: ApplicationStatus): number {
    return this.getFilteredApplicationsByStatus(status).length;
  }

  // Application card helpers
  getMatchScoreClass(score: number | null): string {
    if (!score) return 'low';
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
  }

  formatSalary(min: number | null, max: number | null): string {
    if (!min && !max) return 'Not specified';
    if (min && max) return `$${(min/1000).toFixed(0)}k - $${(max/1000).toFixed(0)}k`;
    if (min) return `$${(min/1000).toFixed(0)}k+`;
    return `Up to $${(max!/1000).toFixed(0)}k`;
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  formatDateTime(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  getNextInterview(app: ApplicationWithInterview): ScheduledInterview | null {
    if (!app.scheduledInterviews?.length) return null;

    const now = new Date();
    const upcoming = app.scheduledInterviews
      .filter(i => new Date(i.scheduled_at) > now && ['pending', 'scheduled'].includes(i.status))
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());

    return upcoming[0] || null;
  }

  hasUpcomingInterview(app: ApplicationWithInterview): boolean {
    return !!this.getNextInterview(app);
  }

  // Group expansion
  toggleGroupExpansion(key: string): void {
    const current = this.expandedGroups();
    const newSet = new Set(current);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    this.expandedGroups.set(newSet);
  }

  isGroupExpanded(key: string): boolean {
    return this.expandedGroups().has(key);
  }

  expandAllGroups(): void {
    const groups = this.getApplicationsGroupedByCandidate();
    const keys = groups.map(g => g.candidateName);
    this.expandedGroups.set(new Set(keys));
  }

  collapseAllGroups(): void {
    this.expandedGroups.set(new Set());
  }

  areAllGroupsExpanded(): boolean {
    const groups = this.getApplicationsGroupedByCandidate();
    if (groups.length === 0) return false;
    return groups.every(g => this.expandedGroups().has(g.candidateName));
  }

  toggleExpandAll(): void {
    if (this.areAllGroupsExpanded()) {
      this.collapseAllGroups();
    } else {
      this.expandAllGroups();
    }
  }

  // Selection
  toggleApplicationSelection(appId: string, event: Event): void {
    event.stopPropagation();
    const current = this.selectedApplications();
    const newSet = new Set(current);
    if (newSet.has(appId)) {
      newSet.delete(appId);
    } else {
      newSet.add(appId);
    }
    this.selectedApplications.set(newSet);
  }

  isApplicationSelected(appId: string): boolean {
    return this.selectedApplications().has(appId);
  }

  clearSelectedApplications(): void {
    this.selectedApplications.set(new Set());
  }

  getSelectedCount(): number {
    return this.selectedApplications().size;
  }

  // Bulk operations
  showBulkStatusMenu = signal(false);

  toggleBulkStatusMenu(): void {
    this.showBulkStatusMenu.set(!this.showBulkStatusMenu());
  }

  async bulkUpdateStatus(status: ApplicationStatus): Promise<void> {
    const selectedIds = Array.from(this.selectedApplications());
    if (selectedIds.length === 0) return;

    this.showBulkStatusMenu.set(false);
    let successCount = 0;
    let errorCount = 0;

    for (const appId of selectedIds) {
      try {
        await this.supabase.updateApplication(appId, { status });
        successCount++;
        // Update local state
        const updatedApps = this.applications().map(a =>
          a.id === appId ? { ...a, status } : a
        );
        this.applications.set(updatedApps);
      } catch {
        errorCount++;
      }
    }

    if (successCount > 0) {
      this.showSuccess(`Updated ${successCount} application(s) to ${this.getStatusLabel(status)}`);
    }
    if (errorCount > 0) {
      this.showError(`Failed to update ${errorCount} application(s)`);
    }
    this.clearSelectedApplications();
  }

  // Sidebar
  openSidebar(app: ApplicationWithInterview): void {
    this.selectedApplication.set(app);
    this.showSidebar.set(true);
  }

  closeSidebar(): void {
    this.showSidebar.set(false);
    setTimeout(() => {
      if (!this.showSidebar()) {
        this.selectedApplication.set(null);
      }
    }, 300);
  }

  // Navigation
  openApplicationDetail(app: ApplicationWithInterview): void {
    this.router.navigate(['/application', app.id]);
  }

  // Sorting
  onSort(field: string): void {
    if (this.sortField === field) {
      if (this.sortOrder === 1) {
        this.sortOrder = -1;
      } else {
        this.sortField = '';
        this.sortOrder = 1;
      }
    } else {
      this.sortField = field;
      this.sortOrder = 1;
    }
  }

  getSortIconClass(field: string): string {
    if (this.sortField !== field) {
      return 'pi pi-sort-alt';
    }
    return this.sortOrder === 1 ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
  }

  // Filter helpers
  hasActiveFilters(): boolean {
    return this.searchQuery.trim() !== '' ||
           this.selectedStatuses.length > 0 ||
           this.selectedPositions.length > 0 ||
           this.selectedSkills.length > 0 ||
           this.selectedWorkTypes.length > 0 ||
           this.selectedExperienceLevels.length > 0 ||
           (this.dateRange.length === 2 && !!this.dateRange[0]) ||
           this.salaryFilterActive;
  }

  hasSalaryFilter(): boolean {
    return this.salaryFilterActive;
  }

  onSalaryFilterChange(): void {
    this.salaryFilterActive = true;
  }

  clearSalaryFilter(): void {
    this.salaryRange = [0, 300000];
    this.salaryFilterActive = false;
  }

  clearAllFilters(): void {
    this.searchQuery = '';
    this.selectedStatuses = [];
    this.selectedPositions = [];
    this.selectedSkills = [];
    this.selectedWorkTypes = [];
    this.selectedExperienceLevels = [];
    this.dateRange = [];
    this.salaryRange = [0, 300000];
    this.salaryFilterActive = false;
    this.sortField = '';
    this.sortOrder = 1;
  }

  formatSalaryK(value: number): string {
    return '$' + (value / 1000).toFixed(0) + 'k';
  }

  // Stats
  getStats(): { total: number; applied: number; interviewing: number; offers: number } {
    const apps = this.applications();
    return {
      total: apps.length,
      applied: apps.filter(a => a.status === 'applied').length,
      interviewing: apps.filter(a => a.status === 'interviewing').length,
      offers: apps.filter(a => a.status === 'offer' || a.status === 'accepted').length,
    };
  }

  getGroupStats(apps: ApplicationWithInterview[]): { extracted: number; applied: number; interviewing: number; offer: number } {
    return {
      extracted: apps.filter(a => a.status === 'extracted').length,
      applied: apps.filter(a => a.status === 'applied').length,
      interviewing: apps.filter(a => a.status === 'interviewing').length,
      offer: apps.filter(a => a.status === 'offer' || a.status === 'accepted').length,
    };
  }

  // Notifications
  private showSuccess(message: string): void {
    this.messageService.add({
      severity: 'success',
      summary: 'Success',
      detail: message,
      life: 3000
    });
  }

  private showError(message: string): void {
    this.messageService.add({
      severity: 'error',
      summary: 'Error',
      detail: message,
      life: 3000
    });
  }
}
