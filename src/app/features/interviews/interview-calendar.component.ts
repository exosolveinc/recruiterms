import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, ViewEncapsulation, inject, effect, HostBinding } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { isSameDay, isSameMonth } from 'date-fns';
import {
  CalendarEvent,
  CalendarView,
  CalendarModule,
  DateAdapter,
  CalendarDateFormatter,
  CalendarUtils,
  CalendarA11y,
  CalendarEventTitleFormatter
} from 'angular-calendar';
import { adapterFactory } from 'angular-calendar/date-adapters/date-fns';
import { MarkdownModule } from 'ngx-markdown';
import { InterviewService, ScheduledInterview, ScheduleAssistantMessage, SuggestedSlot, CreateInterviewRequest } from '../../core/services/interview.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { AppStateService } from '../../core/services/app-state.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { InterviewModalComponent } from '../../shared/interview-modal/interview-modal.component';
import { UserApplicationView } from '../../core/models';
import { environment } from '../../../environments/environment';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import jsPDF from 'jspdf';

interface InterviewCalendarEvent extends CalendarEvent {
  interview?: ScheduledInterview;
}

@Component({
  selector: 'app-interview-calendar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SidebarComponent,
    CalendarModule,
    InterviewModalComponent,
    MarkdownModule
  ],
  templateUrl: './interview-calendar.component.html',
  styleUrls: ['./interview-calendar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [
    { provide: DateAdapter, useFactory: adapterFactory },
    CalendarDateFormatter,
    CalendarUtils,
    CalendarA11y,
    CalendarEventTitleFormatter
  ]
})
export class InterviewCalendarComponent implements OnInit {
  // Inject services
  private appState = inject(AppStateService);
  private supabase = inject(SupabaseService);

  // Use signals from AppStateService
  readonly candidates = this.appState.candidates;
  readonly selectedCandidateId = this.appState.selectedCandidateId;
  readonly selectedCandidate = this.appState.selectedCandidate;

  view: CalendarView = CalendarView.Week;
  CalendarView = CalendarView;
  viewDate: Date = new Date();
  refresh = new Subject<void>();
  activeDayIsOpen = false;

  // All interviews (unfiltered)
  allInterviews: ScheduledInterview[] = [];
  // All applications for mapping
  applications: UserApplicationView[] = [];
  // Filtered events for calendar
  events: InterviewCalendarEvent[] = [];
  loading = true;
  error = '';

  // Selected event for detail view
  selectedInterview: ScheduledInterview | null = null;

  // Edit mode
  isEditing = false;
  editDate = '';
  editTime = '';
  editStatus = '';
  editDuration = 60;
  saving = false;

  // AI Scheduling Assistant state
  showAiPanel = true;
  aiMessages: ScheduleAssistantMessage[] = [];
  aiUserInput = '';
  aiLoading = false;
  aiError = '';
  selectedSlot: SuggestedSlot | null = null;
  aiDuration = 60;

  // Confirmation dialog state
  showConfirmDialog = false;
  pendingSlot: SuggestedSlot | null = null;
  schedulingInterview = false;

  // Schedule Interview Modal (for clicking empty slots)
  showScheduleModal = false;
  clickedDate: Date | null = null;
  availableAppsForSchedule: UserApplicationView[] = [];

  // Expanded Event View
  expandedEventId: string | null = null;
  expandDirection: 'left' | 'right' = 'right';
  expandedEvent: InterviewCalendarEvent | null = null;
  expandedPosition: { top: number; left: number } | null = null;

  // Host binding to add class when event is expanded (for z-index stacking)
  @HostBinding('class.has-expanded-event') get hasExpandedEvent() {
    return !!this.expandedEventId;
  }
  expandedEventData: {
    resume: { name: string; url: string; ready: boolean } | null;
    jobDesc: { name: string; jobId: string; ready: boolean; job: any } | null;
    aiInsight: { content: string; ready: boolean; generating: boolean } | null;
  } | null = null;

  // Pre-loaded insights cache (interviewId -> insight data)
  insightsCache: Map<string, { content: string; ready: boolean; generating: boolean }> = new Map();

  // Pre-loaded jobs cache (jobId -> job data)
  jobsCache: Map<string, any> = new Map();

  // AI Insight Dialog
  showInsightDialog = false;
  insightDialogData: {
    title: string;
    companyName: string;
    content: string;
  } | null = null;

  // Job Description Dialog
  showJobDescDialog = false;
  jobDescDialogData: {
    jobTitle: string;
    companyName: string;
    location: string | null;
    workType: string | null;
    employmentType: string | null;
    experienceLevel: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    descriptionSummary: string | null;
    descriptionFull: string | null;
    responsibilities: string[] | null;
    qualifications: string[] | null;
    requiredSkills: any[] | null;
    benefits: any[] | null;
    sourceUrl: string | null;
  } | null = null;

  // Effect to reload when candidate changes
  private candidateEffect = effect(() => {
    const candidateId = this.selectedCandidateId();
    // Refilter events when candidate changes
    this.filterEventsByCandidate();
    this.cdr.markForCheck();
  });

  constructor(
    private interviewService: InterviewService,
    private cdr: ChangeDetectorRef,
    private http: HttpClient
  ) {}

  async ngOnInit() {
    await this.loadCandidates();
    await this.loadApplications();
    await this.loadInterviews();

    // Pre-load all jobs and AI insights
    await this.loadAllJobs();
    await this.loadAllInsights();

    // Show welcome message in AI panel
    if (this.showAiPanel && this.aiMessages.length === 0) {
      this.aiMessages.push({
        role: 'assistant',
        content: `Hi! I can help schedule interviews, find optimal slots, and coordinate with your team.\n\nTry asking:\n• "Find 3 slots next week for a technical interview"\n• "Propose a schedule for Google"\n• "When is the best time for a 1-hour interview tomorrow?"`,
        timestamp: new Date()
      });
    }
  }

  async loadCandidates() {
    if (this.appState.candidatesLoaded()) return;

    try {
      this.appState.setCandidatesLoading(true);
      const candidates = await this.supabase.getCandidates();
      this.appState.setCandidates(candidates);
    } catch (err) {
      console.error('Failed to load candidates:', err);
    }
  }

  async loadApplications() {
    try {
      this.applications = await this.supabase.getApplicationsWithDetails();
    } catch (err) {
      console.error('Failed to load applications:', err);
      this.applications = [];
    }
  }

  async loadInterviews() {
    this.loading = true;
    this.error = '';

    try {
      this.allInterviews = await this.interviewService.getInterviews();
      this.filterEventsByCandidate();
      this.cdr.markForCheck();
    } catch (err: any) {
      console.error('Failed to load interviews:', err);
      this.error = err.message || 'Failed to load interviews';
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  private filterEventsByCandidate() {
    const candidateId = this.selectedCandidateId();

    if (!candidateId) {
      // Show all interviews if no candidate selected
      this.events = this.allInterviews.map(interview => this.mapInterviewToEvent(interview));
      return;
    }

    // Get candidate's resume IDs
    const candidate = this.candidates().find(c => c.id === candidateId);
    if (!candidate) {
      this.events = this.allInterviews.map(interview => this.mapInterviewToEvent(interview));
      return;
    }

    const candidateResumeIds = new Set(candidate.resumes.map(r => r.id));

    // Get application IDs for this candidate (applications using candidate's resumes)
    const candidateAppIds = new Set(
      this.applications
        .filter(app => app.resume_id && candidateResumeIds.has(app.resume_id))
        .map(app => app.id)
    );

    // Filter interviews by candidate's applications
    const filteredInterviews = this.allInterviews.filter(
      interview => candidateAppIds.has(interview.application_id)
    );

    this.events = filteredInterviews.map(interview => this.mapInterviewToEvent(interview));
  }

  selectCandidate(candidateId: string) {
    this.appState.selectCandidate(candidateId);
  }

  private mapInterviewToEvent(interview: ScheduledInterview): InterviewCalendarEvent {
    const start = new Date(interview.scheduled_at);
    const end = new Date(start.getTime() + interview.duration_minutes * 60 * 1000);

    // Build title with status and type
    const statusLabel = interview.status.charAt(0).toUpperCase() + interview.status.slice(1);
    const typeLabel = this.getInterviewTypeLabel(interview.interview_type);
    const title = `[${statusLabel}] ${interview.title} - ${typeLabel}`;

    return {
      id: interview.id,
      start,
      end,
      title,
      color: this.getEventColor(interview.status, interview.interview_type),
      resizable: {
        beforeStart: false,
        afterEnd: false
      },
      draggable: false,
      interview
    };
  }

  private getEventColor(status: string, type: string): { primary: string; secondary: string } {
    // Status-based colors take priority
    if (status === 'pending') {
      return { primary: '#f59e0b', secondary: '#fef3c7' }; // Amber for pending
    }
    if (status === 'scheduled') {
      return { primary: '#15803d', secondary: '#dcfce7' }; // Green for approved/scheduled
    }
    if (status === 'cancelled') {
      return { primary: '#ad2121', secondary: '#FAE3E3' }; // Red for cancelled
    }
    if (status === 'completed') {
      return { primary: '#6b7280', secondary: '#e5e7eb' }; // Gray for completed
    }

    // For other statuses, use type-based colors
    const colors: Record<string, { primary: string; secondary: string }> = {
      'phone': { primary: '#1e90ff', secondary: '#D1E8FF' },
      'video': { primary: '#6f42c1', secondary: '#e2d9f3' },
      'onsite': { primary: '#fd7e14', secondary: '#ffe5d0' },
      'technical': { primary: '#007bff', secondary: '#cce5ff' },
      'behavioral': { primary: '#20c997', secondary: '#d2f4ea' },
      'panel': { primary: '#6610f2', secondary: '#e0cffc' },
      'other': { primary: '#e3bc08', secondary: '#FDF1BA' }
    };

    return colors[type] || colors['other'];
  }

  setView(view: CalendarView) {
    this.view = view;
  }

  closeOpenMonthViewDay() {
    this.activeDayIsOpen = false;
  }

  dayClicked({ date, events }: { date: Date; events: CalendarEvent[] }): void {
    if (isSameMonth(date, this.viewDate)) {
      if (
        (isSameDay(this.viewDate, date) && this.activeDayIsOpen === true) ||
        events.length === 0
      ) {
        this.activeDayIsOpen = false;
      } else {
        this.activeDayIsOpen = true;
      }
      this.viewDate = date;
    }
  }

  handleEvent(action: string, event: InterviewCalendarEvent): void {
    if (event.interview) {
      this.selectedInterview = event.interview;
      this.cdr.markForCheck();
    }
  }

  closeDetail() {
    this.selectedInterview = null;
    this.isEditing = false;
    this.cdr.markForCheck();
  }

  startEditing() {
    if (!this.selectedInterview) return;

    // Parse the scheduled_at to get date and time in EST
    const scheduled = new Date(this.selectedInterview.scheduled_at);

    // Format date as YYYY-MM-DD for input[type="date"] in EST
    const estDate = new Date(scheduled.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const year = estDate.getFullYear();
    const month = (estDate.getMonth() + 1).toString().padStart(2, '0');
    const day = estDate.getDate().toString().padStart(2, '0');
    this.editDate = `${year}-${month}-${day}`;

    // Format time as HH:MM for input[type="time"] in EST
    const hours = estDate.getHours().toString().padStart(2, '0');
    const minutes = estDate.getMinutes().toString().padStart(2, '0');
    this.editTime = `${hours}:${minutes}`;

    // Set status
    this.editStatus = this.selectedInterview.status;

    // Set duration
    this.editDuration = this.selectedInterview.duration_minutes;

    this.isEditing = true;
    this.cdr.markForCheck();
  }

  cancelEditing() {
    this.isEditing = false;
    this.cdr.markForCheck();
  }

  async saveChanges() {
    if (!this.selectedInterview || !this.editDate || !this.editTime || !this.editStatus) return;

    this.saving = true;
    this.cdr.detectChanges();

    try {
      // Convert the date/time in EST to UTC for storage
      const scheduled_at = this.convertToUTC(this.editDate, this.editTime, 'America/New_York');

      // Update interview via service
      const updated = await this.interviewService.updateInterview(this.selectedInterview.id, {
        scheduled_at,
        status: this.editStatus as any,
        duration_minutes: Number(this.editDuration)
      });

      // Update local state
      this.selectedInterview = updated;

      // Reload interviews to refresh calendar
      await this.loadInterviews();

      this.isEditing = false;
    } catch (err: any) {
      console.error('Failed to update interview:', err);
      alert('Failed to update interview: ' + (err.message || 'Unknown error'));
    } finally {
      this.saving = false;
      this.cdr.detectChanges();
    }
  }

  /**
   * Convert a date and time in a specific timezone to UTC ISO string.
   * The user selects a time they see as being in America/New_York,
   * and we convert that to UTC for storage.
   */
  private convertToUTC(date: string, time: string, timezone: string): string {
    // Parse the date and time components
    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);

    // Formatter for the target timezone
    const tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    // Find the UTC time when target timezone shows our desired time
    // Start with a reasonable guess (UTC time matching the input)
    let guessDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

    // Iterate to find the correct UTC time (handles DST)
    for (let i = 0; i < 3; i++) {
      const tzParts = tzFormatter.formatToParts(guessDate);
      const getPart = (type: string) => parseInt(tzParts.find(p => p.type === type)?.value || '0', 10);

      const tzHour = getPart('hour');
      const tzMinute = getPart('minute');
      const tzDay = getPart('day');

      const hourDiff = hours - tzHour;
      const minuteDiff = minutes - tzMinute;
      const dayDiff = day - tzDay;

      if (hourDiff === 0 && minuteDiff === 0 && dayDiff === 0) {
        break;
      }

      // Adjust by the difference
      guessDate = new Date(guessDate.getTime() +
        (dayDiff * 24 * 60 * 60 * 1000) +
        (hourDiff * 60 * 60 * 1000) +
        (minuteDiff * 60 * 1000)
      );
    }

    return guessDate.toISOString();
  }

  // Get candidate name for an interview
  getCandidateNameForInterview(interview: ScheduledInterview): string | null {
    // First check if interview has candidate_name directly
    if (interview.candidate_name) {
      return interview.candidate_name;
    }

    // Find the application for this interview
    const app = this.applications.find(a => a.id === interview.application_id);
    if (!app || !app.resume_id) return null;

    // Find the candidate who owns this resume
    const candidate = this.candidates().find(c =>
      c.resumes.some(r => r.id === app.resume_id)
    );

    return candidate?.name || null;
  }

  // Helper to get initials for candidate avatar
  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  // Format helpers
  formatTime(date: string | undefined | null): string {
    if (!date) return '';
    try {
      const time = new Date(date).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
      });
      const tzAbbr = new Date(date).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'short'
      }).split(' ').pop(); // Gets EST or EDT
      return `${time} ${tzAbbr}`;
    } catch {
      return '';
    }
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York'
    });
  }

  getInterviewTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      'phone': 'Phone Interview',
      'video': 'Video Interview',
      'onsite': 'Onsite Interview',
      'technical': 'Technical Interview',
      'behavioral': 'Behavioral Interview',
      'panel': 'Panel Interview',
      'other': 'Interview'
    };
    return labels[type] || type;
  }

  getStatusClass(status: string): string {
    const classes: Record<string, string> = {
      'pending': 'status-pending',
      'scheduled': 'status-scheduled',
      'completed': 'status-completed',
      'cancelled': 'status-cancelled',
      'rescheduled': 'status-rescheduled',
      'no_show': 'status-no-show'
    };
    return classes[status] || '';
  }

  getEventTooltip(event: InterviewCalendarEvent): string {
    if (!event.interview) return event.title || 'Interview';

    const interview = event.interview;
    const lines: string[] = [];

    lines.push(interview.title || 'Interview');
    lines.push(`Type: ${this.getInterviewTypeLabel(interview.interview_type)}`);
    lines.push(`Date: ${this.formatDate(interview.scheduled_at)}`);
    lines.push(`Time: ${this.formatTime(interview.scheduled_at)}`);
    lines.push(`Duration: ${interview.duration_minutes} minutes`);
    lines.push(`Status: ${interview.status}`);

    if (interview.interviewer_name) {
      lines.push(`Interviewer: ${interview.interviewer_name}`);
    }

    if (interview.location) {
      lines.push(`Location: ${interview.location}`);
    }

    return lines.join('\n');
  }

  // Approve a pending interview
  async approveInterview() {
    if (!this.selectedInterview || this.selectedInterview.status !== 'pending') return;

    this.saving = true;

    try {
      const updated = await this.interviewService.approveInterview(this.selectedInterview.id);

      // Update local state
      this.selectedInterview = updated;

      // Reload interviews to refresh calendar
      await this.loadInterviews();

      this.cdr.markForCheck();
    } catch (err: any) {
      console.error('Failed to approve interview:', err);
      alert('Failed to approve interview: ' + (err.message || 'Unknown error'));
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  // Revert a scheduled interview back to pending
  async revertToPending() {
    if (!this.selectedInterview || this.selectedInterview.status !== 'scheduled') return;

    this.saving = true;

    try {
      const updated = await this.interviewService.updateInterview(this.selectedInterview.id, {
        status: 'pending'
      });

      // Update local state
      this.selectedInterview = updated;

      // Reload interviews to refresh calendar
      await this.loadInterviews();

      this.cdr.markForCheck();
    } catch (err: any) {
      console.error('Failed to revert interview:', err);
      alert('Failed to revert interview: ' + (err.message || 'Unknown error'));
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  // Delete an interview
  async deleteInterview() {
    if (!this.selectedInterview) return;

    const confirmed = confirm('Are you sure you want to delete this interview? This action cannot be undone.');
    if (!confirmed) return;

    this.saving = true;

    try {
      await this.interviewService.deleteInterview(this.selectedInterview.id);

      // Close modal and reload
      this.selectedInterview = null;
      await this.loadInterviews();

      this.cdr.markForCheck();
    } catch (err: any) {
      console.error('Failed to delete interview:', err);
      alert('Failed to delete interview: ' + (err.message || 'Unknown error'));
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  // ============================================================================
  // AI SCHEDULING ASSISTANT
  // ============================================================================

  toggleAiPanel() {
    this.showAiPanel = !this.showAiPanel;

    // Show welcome message on first open
    if (this.showAiPanel && this.aiMessages.length === 0) {
      this.aiMessages.push({
        role: 'assistant',
        content: `Hi! I can help schedule interviews, find optimal slots, and coordinate with your team.\n\nTry asking:\n• "Find 3 slots next week for a technical interview"\n• "Propose a schedule for Google"\n• "When is the best time for a 1-hour interview tomorrow?"`,
        timestamp: new Date()
      });
      this.cdr.markForCheck();
    }
  }

  async sendAiMessage() {
    if (!this.aiUserInput.trim() || this.aiLoading) return;

    const userMessage = this.aiUserInput.trim();
    this.aiUserInput = '';
    this.aiError = '';

    // Add user message to chat
    this.aiMessages.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date()
    });

    this.aiLoading = true;
    this.cdr.markForCheck();

    try {
      // Build conversation history for context
      const conversationHistory = this.aiMessages
        .filter(m => !m.suggestedSlots || m.suggestedSlots.length === 0)
        .map(m => ({ role: m.role, content: m.content }));

      // Get resume IDs for the selected candidate
      const candidate = this.selectedCandidate();
      const resumeIds = candidate?.resumes?.map(r => r.id) || [];

      const response = await this.interviewService.getEnhancedSchedulingSuggestions({
        userMessage,
        duration: this.aiDuration,
        dateRange: this.interviewService.getDateRangeForScheduling(14),
        timezone: 'America/New_York',
        resumeIds: resumeIds.length > 0 ? resumeIds : undefined,
        conversationHistory: conversationHistory.slice(-10)
      });

      // Add assistant response
      this.aiMessages.push({
        role: 'assistant',
        content: response.message,
        suggestedSlots: response.suggestedSlots,
        timestamp: new Date()
      });

    } catch (err: any) {
      this.aiError = err.message || 'Failed to get suggestions';
      this.aiMessages.push({
        role: 'assistant',
        content: 'Sorry, I encountered an error while checking availability. Please try again.',
        timestamp: new Date()
      });
    } finally {
      this.aiLoading = false;
      this.cdr.markForCheck();
    }
  }

  selectSuggestedSlot(slot: SuggestedSlot) {
    this.pendingSlot = slot;
    this.showConfirmDialog = true;
    this.cdr.markForCheck();
  }

  cancelConfirmDialog() {
    this.showConfirmDialog = false;
    this.pendingSlot = null;
    this.cdr.markForCheck();
  }

  async confirmScheduleInterview() {
    if (!this.pendingSlot) return;

    this.schedulingInterview = true;
    this.cdr.markForCheck();

    try {
      const slot = this.pendingSlot;

      // Find the application if we have one
      let applicationId = slot.applicationId;
      let title = 'Interview';

      if (slot.companyName && slot.jobTitle) {
        title = `${slot.jobTitle} at ${slot.companyName}`;
      } else if (slot.companyName) {
        title = `Interview at ${slot.companyName}`;
      }

      // If no applicationId, try to find one based on company name
      if (!applicationId && slot.companyName) {
        const matchingApp = this.applications.find(
          app => app.company_name?.toLowerCase().includes(slot.companyName!.toLowerCase())
        );
        if (matchingApp) {
          applicationId = matchingApp.id;
          title = `${matchingApp.job_title} at ${matchingApp.company_name}`;
        } else {
          // No matching application found for the specified company
          this.showConfirmDialog = false;
          this.pendingSlot = null;
          this.schedulingInterview = false;
          this.aiMessages.push({
            role: 'assistant',
            content: `I can't schedule an interview for ${slot.companyName} because you haven't applied to any jobs at this company yet. Please apply to a job first, then I can help you schedule an interview.`,
            timestamp: new Date()
          });
          this.cdr.markForCheck();
          return;
        }
      }

      if (!applicationId) {
        throw new Error('No application found. Please apply to a job first before scheduling an interview.');
      }

      // Convert date/time to UTC
      const scheduledAt = this.convertToUTC(slot.date, slot.startTime, 'America/New_York');

      const request: CreateInterviewRequest = {
        application_id: applicationId,
        title: title,
        interview_type: 'video',
        scheduled_at: scheduledAt,
        duration_minutes: this.aiDuration,
        timezone: 'America/New_York',
        add_to_google_calendar: true
      };

      const interview = await this.interviewService.scheduleInterview(request);

      // Close dialog and reload
      this.showConfirmDialog = false;
      this.pendingSlot = null;

      // Add confirmation message to chat
      this.aiMessages.push({
        role: 'assistant',
        content: `Interview scheduled for ${this.formatSlotDisplay(slot)}. It has been added to your calendar.`,
        timestamp: new Date()
      });

      // Reload interviews to show new one
      await this.loadInterviews();

      this.cdr.markForCheck();
    } catch (err: any) {
      console.error('Failed to schedule interview:', err);
      alert('Failed to schedule interview: ' + (err.message || 'Unknown error'));
    } finally {
      this.schedulingInterview = false;
      this.cdr.markForCheck();
    }
  }

  onAiInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendAiMessage();
    }
  }

  formatSlotDisplay(slot: SuggestedSlot): string {
    const date = new Date(slot.date);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    // Convert 24h to 12h format
    const [hours, minutes] = slot.startTime.split(':');
    const hour = parseInt(hours, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    const time12 = `${hour12}:${minutes} ${ampm}`;

    return `${dayName} at ${time12}`;
  }

  isSlotSelected(slot: SuggestedSlot): boolean {
    if (!this.selectedSlot) return false;
    return this.selectedSlot.date === slot.date &&
           this.selectedSlot.startTime === slot.startTime;
  }

  sendQuickAction(action: 'propose' | 'reschedule' | 'reminder') {
    const actions = {
      'propose': 'Propose optimal interview times for next week',
      'reschedule': 'Find alternative times for rescheduling',
      'reminder': 'Set up interview reminders'
    };
    this.aiUserInput = actions[action];
    this.sendAiMessage();
  }

  // ============================================================================
  // SCHEDULE MODAL (Empty slot click)
  // ============================================================================

  /**
   * Handle click on empty hour segment in week/day view
   */
  onHourSegmentClicked(event: { date: Date; sourceEvent: MouseEvent }) {
    // Get applications for current candidate
    const candidateApps = this.getCandidateApplications();

    if (candidateApps.length === 0) {
      alert('No applications found. Please add an application first before scheduling an interview.');
      return;
    }

    this.clickedDate = event.date;
    this.availableAppsForSchedule = candidateApps;
    this.showScheduleModal = true;
    this.cdr.markForCheck();
  }

  /**
   * Get applications for the selected candidate
   */
  getCandidateApplications(): UserApplicationView[] {
    const candidateId = this.selectedCandidateId();

    if (!candidateId) {
      // No candidate selected, show all applications
      return this.applications;
    }

    // Get candidate's resume IDs
    const candidate = this.candidates().find(c => c.id === candidateId);
    if (!candidate) {
      return this.applications;
    }

    const candidateResumeIds = new Set(candidate.resumes.map(r => r.id));

    // Filter applications by candidate's resumes
    return this.applications.filter(
      app => app.resume_id && candidateResumeIds.has(app.resume_id)
    );
  }

  /**
   * Close the schedule modal
   */
  closeScheduleModal() {
    this.showScheduleModal = false;
    this.clickedDate = null;
    this.availableAppsForSchedule = [];
    this.cdr.markForCheck();
  }

  /**
   * Handle interview scheduled from modal
   */
  async onInterviewScheduled(interview: ScheduledInterview) {
    this.closeScheduleModal();
    await this.loadInterviews();

    // Auto-generate AI insights for newly scheduled interview
    this.generateAiInsightForInterview(interview.id);

    this.cdr.markForCheck();
  }

  // ============================================================================
  // EXPANDED EVENT VIEW
  // ============================================================================

  /**
   * Toggle expanded view for an event
   */
  toggleExpandedEvent(event: InterviewCalendarEvent, dayIndex: number, clickEvent?: MouseEvent) {
    if (!event.interview) return;

    const interviewId = event.interview.id;

    // If already expanded, collapse
    if (this.expandedEventId === interviewId) {
      this.collapseEvent();
      return;
    }

    // Remove expanded-column class from any previous column
    this.clearExpandedColumnClass();

    // Smart positioning: days 0-3 expand right, days 4-6 expand left
    this.expandDirection = dayIndex >= 4 ? 'left' : 'right';
    this.expandedEventId = interviewId;
    this.expandedEvent = event;

    // Calculate position for the overlay
    if (clickEvent) {
      const target = clickEvent.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      this.expandedPosition = {
        top: rect.top,
        left: this.expandDirection === 'right' ? rect.left : rect.right - 340
      };
      this.addExpandedColumnClass(clickEvent.target as HTMLElement);
    }

    // Load event data
    this.loadExpandedEventData(event.interview);
    this.cdr.markForCheck();
  }

  /**
   * Add expanded-parent class to all parent containers for z-index stacking
   */
  private addExpandedColumnClass(element: HTMLElement) {
    let current: HTMLElement | null = element;
    while (current) {
      // Add class to cal-event, cal-event-container, and cal-day-column
      if (current.classList?.contains('cal-event') ||
          current.classList?.contains('cal-event-container') ||
          current.classList?.contains('cal-day-column')) {
        current.classList.add('expanded-parent');
      }
      // Stop at day column level
      if (current.classList?.contains('cal-day-column')) {
        break;
      }
      current = current.parentElement;
    }
  }

  /**
   * Remove expanded-parent class from all elements
   */
  private clearExpandedColumnClass() {
    const elements = document.querySelectorAll('.expanded-parent');
    elements.forEach(el => el.classList.remove('expanded-parent'));
  }

  /**
   * Collapse expanded event
   */
  collapseEvent() {
    this.clearExpandedColumnClass();
    this.expandedEventId = null;
    this.expandedEvent = null;
    this.expandedPosition = null;
    this.expandedEventData = null;
    this.cdr.markForCheck();
  }

  /**
   * Check if event is expanded
   */
  isEventExpanded(interview: ScheduledInterview): boolean {
    return this.expandedEventId === interview.id;
  }

  /**
   * Load data for expanded event view
   */
  async loadExpandedEventData(interview: ScheduledInterview) {
    // Find the application for this interview
    const app = this.applications.find(a => a.id === interview.application_id);

    // Get resume info
    let resumeData = null;
    if (app?.resume_id) {
      const candidate = this.candidates().find(c =>
        c.resumes.some(r => r.id === app.resume_id)
      );
      const resume = candidate?.resumes.find(r => r.id === app.resume_id);
      if (resume) {
        resumeData = {
          name: resume.file_name || 'Resume.pdf',
          url: resume.file_url || '',
          ready: true
        };
      }
    }

    // Get job description from cache
    let jobDescData = null;
    if (app?.job_id) {
      const jobData = this.jobsCache.get(app.job_id);
      if (jobData) {
        jobDescData = {
          name: `${jobData.company_name || app.company_name} - ${jobData.job_title || app.job_title}`,
          jobId: jobData.id,
          ready: true,
          job: jobData
        };
      }
    }

    // Check for existing AI insight
    const existingInsight = await this.getExistingAiInsight(interview.id);

    this.expandedEventData = {
      resume: resumeData,
      jobDesc: jobDescData,
      aiInsight: existingInsight || {
        content: '',
        ready: false,
        generating: false
      }
    };

    this.cdr.markForCheck();
  }

  /**
   * Load all AI insights for interviews on page init
   */
  async loadAllInsights() {
    if (this.allInterviews.length === 0) return;

    try {
      const interviewIds = this.allInterviews.map(i => i.id);
      const { data } = await this.supabase.supabaseClient
        .from('interview_ai_insights')
        .select('interview_id, content')
        .in('interview_id', interviewIds);

      if (data) {
        data.forEach((insight: { interview_id: string; content: string }) => {
          this.insightsCache.set(insight.interview_id, {
            content: insight.content,
            ready: true,
            generating: false
          });
        });
      }
      this.cdr.markForCheck();
    } catch (err) {
      console.error('Failed to load insights:', err);
    }
  }

  /**
   * Load all jobs for applications on page init
   */
  async loadAllJobs() {
    if (this.applications.length === 0) return;

    try {
      // Get unique job IDs from applications
      const jobIds = [...new Set(this.applications.map(a => a.job_id).filter(Boolean))];
      if (jobIds.length === 0) return;

      const { data } = await this.supabase.supabaseClient
        .from('jobs')
        .select('*')
        .in('id', jobIds);

      if (data) {
        data.forEach((job: any) => {
          this.jobsCache.set(job.id, job);
        });
      }
      this.cdr.markForCheck();
    } catch (err) {
      console.error('Failed to load jobs:', err);
    }
  }

  /**
   * Get existing AI insight for interview
   */
  async getExistingAiInsight(interviewId: string): Promise<{ content: string; ready: boolean; generating: boolean } | null> {
    // Check cache first
    if (this.insightsCache.has(interviewId)) {
      return this.insightsCache.get(interviewId)!;
    }

    try {
      const { data } = await this.supabase.supabaseClient
        .from('interview_ai_insights')
        .select('content')
        .eq('interview_id', interviewId)
        .maybeSingle();

      if (data?.content) {
        const insight = { content: data.content, ready: true, generating: false };
        this.insightsCache.set(interviewId, insight);
        return insight;
      }
    } catch (err) {
      // No insight exists yet
    }
    return null;
  }

  /**
   * Check if insight exists for interview (from cache)
   */
  hasInsight(interviewId: string): boolean {
    return this.insightsCache.has(interviewId);
  }

  /**
   * Generate AI insight for interview
   */
  async generateAiInsight() {
    if (!this.expandedEventId || !this.expandedEventData) return;

    const interview = this.allInterviews.find(i => i.id === this.expandedEventId);
    if (!interview) return;

    this.expandedEventData.aiInsight = {
      content: '',
      ready: false,
      generating: true
    };
    this.cdr.markForCheck();

    await this.generateAiInsightForInterview(interview.id);

    // Reload the insight (will also update cache)
    const insight = await this.getExistingAiInsight(interview.id);
    if (insight) {
      this.expandedEventData.aiInsight = insight;
      // Update cache
      this.insightsCache.set(interview.id, insight);
    } else {
      this.expandedEventData.aiInsight = {
        content: 'Failed to generate insight. Please try again.',
        ready: false,
        generating: false
      };
    }
    this.cdr.markForCheck();
  }

  /**
   * Generate AI insight for a specific interview
   */
  async generateAiInsightForInterview(interviewId: string) {
    try {
      const interview = this.allInterviews.find(i => i.id === interviewId);
      if (!interview) return;

      const app = this.applications.find(a => a.id === interview.application_id);
      if (!app) return;

      // Get resume content
      const candidate = this.candidates().find(c =>
        c.resumes.some(r => r.id === app.resume_id)
      );
      const resume = candidate?.resumes.find(r => r.id === app.resume_id);

      const headers = new HttpHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${environment.supabaseAnonKey}`
      });

      // Call edge function to generate insight
      await firstValueFrom(
        this.http.post(`${environment.supabaseUrl}/functions/v1/generate-interview-insight`, {
          interviewId,
          applicationId: app.id,
          jobTitle: app.job_title,
          companyName: app.company_name,
          jobDescription: '', // Job description is not in UserApplicationView
          resumeSummary: resume?.professional_summary || '',
          workHistory: resume?.work_history || [],
          skills: resume?.skills || []
        }, { headers })
      );
    } catch (err) {
      console.error('Failed to generate AI insight:', err);
    }
  }

  /**
   * View resume in new tab
   */
  viewResume() {
    if (this.expandedEventData?.resume?.url) {
      window.open(this.expandedEventData.resume.url, '_blank');
    }
  }

  /**
   * View resume from event (for hover actions)
   */
  viewResumeFromEvent(interview: ScheduledInterview) {
    const app = this.applications.find(a => a.id === interview.application_id);
    if (!app?.resume_id) return;

    const candidate = this.candidates().find(c =>
      c.resumes.some(r => r.id === app.resume_id)
    );
    const resume = candidate?.resumes.find(r => r.id === app.resume_id);
    if (resume?.file_url) {
      window.open(resume.file_url, '_blank');
    }
  }

  /**
   * View job description from event (for hover actions)
   */
  viewJobDescFromEvent(interview: ScheduledInterview) {
    const app = this.applications.find(a => a.id === interview.application_id);
    if (!app?.job_id) return;

    const jobData = this.jobsCache.get(app.job_id);
    if (jobData) {
      this.jobDescDialogData = {
        jobTitle: jobData.job_title || 'Job Position',
        companyName: jobData.company_name || '',
        location: jobData.location,
        workType: jobData.work_type,
        employmentType: jobData.employment_type,
        experienceLevel: jobData.experience_level,
        salaryMin: jobData.salary_min,
        salaryMax: jobData.salary_max,
        salaryCurrency: jobData.salary_currency || 'USD',
        descriptionSummary: jobData.description_summary,
        descriptionFull: jobData.description_full,
        responsibilities: jobData.responsibilities,
        qualifications: jobData.qualifications,
        requiredSkills: jobData.required_skills,
        benefits: jobData.benefits,
        sourceUrl: jobData.source_url
      };
      this.showJobDescDialog = true;
      this.cdr.markForCheck();
    }
  }

  /**
   * View AI insight from event (for hover actions)
   */
  async viewAiInsightFromEvent(interview: ScheduledInterview) {
    const app = this.applications.find(a => a.id === interview.application_id);

    // Check cache first
    let insightContent = this.insightsCache.get(interview.id)?.content;

    // If not in cache, fetch from database
    if (!insightContent) {
      try {
        const { data } = await this.supabase.supabaseClient
          .from('interview_ai_insights')
          .select('content')
          .eq('interview_id', interview.id)
          .single();

        if (data?.content) {
          insightContent = data.content;
          this.insightsCache.set(interview.id, {
            content: data.content,
            ready: true,
            generating: false
          });
        }
      } catch (err) {
        console.error('Failed to load AI insight:', err);
      }
    }

    if (insightContent) {
      this.insightDialogData = {
        title: app?.job_title || interview.title || 'Interview',
        companyName: app?.company_name || '',
        content: insightContent
      };
      this.showInsightDialog = true;
      this.cdr.markForCheck();
    }
  }

  /**
   * Download resume
   */
  async downloadResume() {
    if (!this.expandedEventData?.resume?.url) return;

    try {
      const response = await fetch(this.expandedEventData.resume.url);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = this.expandedEventData.resume.name || 'resume.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up the blob URL
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Failed to download resume:', err);
      // Fallback: open in new tab
      window.open(this.expandedEventData.resume.url, '_blank');
    }
  }

  /**
   * View job description in dialog
   */
  viewJobDesc() {
    if (!this.expandedEventData?.jobDesc?.job) return;

    const job = this.expandedEventData.jobDesc.job;
    this.jobDescDialogData = {
      jobTitle: job.job_title || 'Job Position',
      companyName: job.company_name || '',
      location: job.location,
      workType: job.work_type,
      employmentType: job.employment_type,
      experienceLevel: job.experience_level,
      salaryMin: job.salary_min,
      salaryMax: job.salary_max,
      salaryCurrency: job.salary_currency || 'USD',
      descriptionSummary: job.description_summary,
      descriptionFull: job.description_full,
      responsibilities: job.responsibilities,
      qualifications: job.qualifications,
      requiredSkills: job.required_skills,
      benefits: job.benefits,
      sourceUrl: job.source_url
    };
    this.showJobDescDialog = true;
    this.cdr.markForCheck();
  }

  /**
   * Close job description dialog
   */
  closeJobDescDialog() {
    this.showJobDescDialog = false;
    this.jobDescDialogData = null;
    this.cdr.markForCheck();
  }

  /**
   * Download job description as PDF
   */
  downloadJobDesc() {
    if (!this.jobDescDialogData && this.expandedEventData?.jobDesc?.job) {
      // If dialog not open, use expanded event data
      const job = this.expandedEventData.jobDesc.job;
      this.jobDescDialogData = {
        jobTitle: job.job_title || 'Job Position',
        companyName: job.company_name || '',
        location: job.location,
        workType: job.work_type,
        employmentType: job.employment_type,
        experienceLevel: job.experience_level,
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        salaryCurrency: job.salary_currency || 'USD',
        descriptionSummary: job.description_summary,
        descriptionFull: job.description_full,
        responsibilities: job.responsibilities,
        qualifications: job.qualifications,
        requiredSkills: job.required_skills,
        benefits: job.benefits,
        sourceUrl: job.source_url
      };
    }

    if (!this.jobDescDialogData) return;

    const data = this.jobDescDialogData;

    // Create PDF using jsPDF
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 20;
    const maxWidth = pageWidth - margin * 2;
    let yPos = margin;

    // Helper to check and add new page if needed
    const checkPageBreak = (requiredSpace: number) => {
      if (yPos + requiredSpace > pageHeight - margin) {
        pdf.addPage();
        yPos = margin;
      }
    };

    // Header - Job Title
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(17, 17, 17);
    pdf.text(data.jobTitle, margin, yPos);
    yPos += 10;

    // Company name
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(data.companyName, margin, yPos);
    yPos += 8;

    // Meta info (location, work type, etc.)
    pdf.setFontSize(10);
    pdf.setTextColor(100, 100, 100);
    const metaItems: string[] = [];
    if (data.location) metaItems.push(data.location);
    if (data.workType) metaItems.push(data.workType);
    if (data.employmentType) metaItems.push(data.employmentType);
    if (data.experienceLevel) metaItems.push(data.experienceLevel);
    if (metaItems.length > 0) {
      pdf.text(metaItems.join('  |  '), margin, yPos);
      yPos += 6;
    }

    // Salary
    if (data.salaryMin || data.salaryMax) {
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(21, 128, 61); // Green
      const currency = data.salaryCurrency || '$';
      let salaryText = '';
      if (data.salaryMin && data.salaryMax) {
        salaryText = `${currency}${data.salaryMin.toLocaleString()} - ${currency}${data.salaryMax.toLocaleString()}`;
      } else if (data.salaryMin) {
        salaryText = `${currency}${data.salaryMin.toLocaleString()}+`;
      } else if (data.salaryMax) {
        salaryText = `Up to ${currency}${data.salaryMax.toLocaleString()}`;
      }
      pdf.text(salaryText, margin, yPos);
      yPos += 5;
    }

    // Line separator
    yPos += 3;
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.5);
    pdf.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 10;

    // Helper function for sections
    const addSection = (title: string, content: string | string[] | null) => {
      if (!content || (Array.isArray(content) && content.length === 0)) return;

      checkPageBreak(20);

      // Section title
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(17, 17, 17);
      pdf.text(title, margin, yPos);
      yPos += 7;

      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(51, 51, 51);

      if (Array.isArray(content)) {
        for (const item of content) {
          checkPageBreak(10);
          const wrappedText = pdf.splitTextToSize(`\u2022 ${item}`, maxWidth - 5);
          pdf.text(wrappedText, margin + 3, yPos);
          yPos += wrappedText.length * 5 + 2;
        }
      } else {
        const wrappedText = pdf.splitTextToSize(content, maxWidth);
        for (let i = 0; i < wrappedText.length; i++) {
          checkPageBreak(6);
          pdf.text(wrappedText[i], margin, yPos);
          yPos += 5;
        }
      }
      yPos += 5;
    };

    // Summary
    addSection('Summary', data.descriptionSummary);

    // Description
    addSection('Description', data.descriptionFull);

    // Responsibilities
    addSection('Responsibilities', data.responsibilities);

    // Qualifications
    addSection('Qualifications', data.qualifications);

    // Required Skills
    if (data.requiredSkills?.length) {
      checkPageBreak(20);
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(17, 17, 17);
      pdf.text('Required Skills', margin, yPos);
      yPos += 7;

      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(51, 51, 51);

      const skills = data.requiredSkills.map((s: any) =>
        typeof s === 'string' ? s : s.name || s.skill || s.title || ''
      ).filter(Boolean);

      const skillsText = skills.join(', ');
      const wrappedSkills = pdf.splitTextToSize(skillsText, maxWidth);
      pdf.text(wrappedSkills, margin, yPos);
      yPos += wrappedSkills.length * 5 + 5;
    }

    // Benefits
    if (data.benefits?.length) {
      checkPageBreak(20);
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(17, 17, 17);
      pdf.text('Benefits', margin, yPos);
      yPos += 7;

      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(51, 51, 51);

      for (const benefit of data.benefits) {
        checkPageBreak(10);
        let benefitText: string;
        if (typeof benefit === 'string') {
          benefitText = benefit;
        } else if (benefit?.category && benefit?.items) {
          benefitText = `${benefit.category}: ${benefit.items.join(', ')}`;
        } else {
          benefitText = benefit?.name || benefit?.benefit || benefit?.title || benefit?.description || '';
        }
        if (benefitText) {
          const wrappedText = pdf.splitTextToSize(`\u2022 ${benefitText}`, maxWidth - 5);
          pdf.text(wrappedText, margin + 3, yPos);
          yPos += wrappedText.length * 5 + 2;
        }
      }
    }

    // Save the PDF
    const fileName = `Job-Description-${data.companyName.replace(/[^a-zA-Z0-9]/g, '-')}-${data.jobTitle.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;
    pdf.save(fileName);
  }

  /**
   * View AI insight in dialog
   */
  viewAiInsight() {
    if (!this.expandedEventId || !this.expandedEventData?.aiInsight?.content) return;

    const interview = this.allInterviews.find(i => i.id === this.expandedEventId);
    if (!interview) return;

    const app = this.applications.find(a => a.id === interview.application_id);

    this.insightDialogData = {
      title: app?.job_title || interview.title || 'Interview',
      companyName: app?.company_name || '',
      content: this.expandedEventData.aiInsight.content
    };
    this.showInsightDialog = true;
    this.cdr.markForCheck();
  }

  /**
   * Close insight dialog
   */
  closeInsightDialog() {
    this.showInsightDialog = false;
    this.insightDialogData = null;
    this.cdr.markForCheck();
  }

  /**
   * Download AI insight as PDF
   */
  downloadAiInsightPdf() {
    let title: string;
    let companyName: string;
    let content: string;

    // Try to get data from dialog first, then from expanded event
    if (this.insightDialogData) {
      title = this.insightDialogData.title;
      companyName = this.insightDialogData.companyName;
      content = this.insightDialogData.content;
    } else if (this.expandedEventId && this.expandedEventData?.aiInsight?.content) {
      const interview = this.allInterviews.find(i => i.id === this.expandedEventId);
      if (!interview) return;
      const app = this.applications.find(a => a.id === interview.application_id);
      title = app?.job_title || interview.title || 'Interview';
      companyName = app?.company_name || '';
      content = this.expandedEventData.aiInsight.content;
    } else {
      return;
    }

    // Create PDF using jsPDF
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 20;
    const maxWidth = pageWidth - margin * 2;
    let yPos = margin;

    // Header
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Interview Preparation Notes', margin, yPos);
    yPos += 10;

    // Subtitle
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(`${title} at ${companyName}`, margin, yPos);
    yPos += 7;

    // Date
    pdf.setFontSize(10);
    pdf.setTextColor(150, 150, 150);
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    pdf.text(`Generated: ${dateStr}`, margin, yPos);
    yPos += 5;

    // Line separator
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.5);
    pdf.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 10;

    // Content - process markdown-like content
    pdf.setTextColor(51, 51, 51);
    const lines = content.split('\n');

    for (const line of lines) {
      // Check if we need a new page
      if (yPos > pageHeight - margin - 10) {
        pdf.addPage();
        yPos = margin;
      }

      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('## ')) {
        // Section header
        yPos += 5;
        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        const headerText = trimmedLine.replace(/^## /, '');
        pdf.text(headerText, margin, yPos);
        yPos += 8;
        pdf.setFont('helvetica', 'normal');
      } else if (trimmedLine.startsWith('- ')) {
        // Bullet point
        pdf.setFontSize(11);
        const bulletText = trimmedLine.replace(/^- /, '');
        const wrappedText = pdf.splitTextToSize(`  \u2022 ${bulletText}`, maxWidth);
        pdf.text(wrappedText, margin, yPos);
        yPos += wrappedText.length * 5 + 2;
      } else if (trimmedLine.startsWith('**') && trimmedLine.endsWith('**')) {
        // Bold text
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        const boldText = trimmedLine.replace(/^\*\*/, '').replace(/\*\*$/, '');
        const wrappedText = pdf.splitTextToSize(boldText, maxWidth);
        pdf.text(wrappedText, margin, yPos);
        yPos += wrappedText.length * 5 + 2;
        pdf.setFont('helvetica', 'normal');
      } else if (trimmedLine) {
        // Regular paragraph
        pdf.setFontSize(11);
        // Handle inline bold by removing markers (jsPDF doesn't support mixed formatting)
        const cleanText = trimmedLine.replace(/\*\*(.+?)\*\*/g, '$1');
        const wrappedText = pdf.splitTextToSize(cleanText, maxWidth);
        pdf.text(wrappedText, margin, yPos);
        yPos += wrappedText.length * 5 + 2;
      } else {
        // Empty line - add small spacing
        yPos += 3;
      }
    }

    // Save the PDF
    const fileName = `Interview-Prep-${companyName.replace(/[^a-zA-Z0-9]/g, '-')}-${title.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;
    pdf.save(fileName);
  }

  /**
   * Copy AI insight to clipboard
   */
  copyAiInsight() {
    if (this.expandedEventData?.aiInsight?.content) {
      navigator.clipboard.writeText(this.expandedEventData.aiInsight.content);
    }
  }

  /**
   * Get day index for an event (0-6 for Sun-Sat)
   */
  getEventDayIndex(event: InterviewCalendarEvent): number {
    if (!event.start) return 3; // Default to middle
    return event.start.getDay();
  }

  /**
   * Get display text for a skill object
   */
  getSkillDisplay(skill: any): string {
    if (typeof skill === 'string') return skill;
    return skill?.name || skill?.skill || skill?.title || JSON.stringify(skill);
  }

  /**
   * Get display text for a benefit object
   */
  getBenefitDisplay(benefit: any): string {
    if (typeof benefit === 'string') return benefit;
    // Handle {category, items[]} structure
    if (benefit?.category && benefit?.items) {
      return `${benefit.category}: ${benefit.items.join(', ')}`;
    }
    return benefit?.name || benefit?.benefit || benefit?.title || benefit?.description || '';
  }
}
