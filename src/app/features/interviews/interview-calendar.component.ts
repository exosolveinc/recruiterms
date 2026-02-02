import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, ViewEncapsulation, inject, effect } from '@angular/core';
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
import { InterviewService, ScheduledInterview, ScheduleAssistantMessage, SuggestedSlot, CreateInterviewRequest } from '../../core/services/interview.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { AppStateService } from '../../core/services/app-state.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { InterviewModalComponent } from '../../shared/interview-modal/interview-modal.component';
import { UserApplicationView } from '../../core/models';

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
    InterviewModalComponent
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

  // Effect to reload when candidate changes
  private candidateEffect = effect(() => {
    const candidateId = this.selectedCandidateId();
    // Refilter events when candidate changes
    this.filterEventsByCandidate();
    this.cdr.markForCheck();
  });

  constructor(
    private interviewService: InterviewService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    await this.loadCandidates();
    await this.loadApplications();
    await this.loadInterviews();

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
        status: this.editStatus as any
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
  formatTime(date: string): string {
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
        }
      }

      // Use first available application if none found
      if (!applicationId && this.applications.length > 0) {
        const firstApp = this.applications[0];
        applicationId = firstApp.id;
        if (!slot.companyName) {
          title = `${firstApp.job_title} at ${firstApp.company_name}`;
        }
      }

      if (!applicationId) {
        throw new Error('No application found. Please select an application first.');
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
    this.cdr.markForCheck();
  }
}
