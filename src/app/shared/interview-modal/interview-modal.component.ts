import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  CreateInterviewRequest,
  InterviewService,
  ScheduledInterview,
  ScheduleAssistantMessage,
  SuggestedSlot
} from '../../core/services/interview.service';
import { UserApplicationView } from '../../core/models';

@Component({
  selector: 'app-interview-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './interview-modal.component.html',
  styleUrls: ['./interview-modal.component.scss']
})
export class InterviewModalComponent implements OnInit {
  @Input() application!: UserApplicationView;
  @Input() existingInterview?: ScheduledInterview;
  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<ScheduledInterview>();

  saving = false;
  error = '';

  // Form fields
  title = '';
  interviewType: ScheduledInterview['interview_type'] = 'video';
  scheduledDate = '';
  scheduledTime = '';
  duration = 60;
  timezone = '';
  location = '';
  meetingLink = '';
  interviewerName = '';
  interviewerEmail = '';
  notes = '';
  addToGoogleCalendar = true;

  // AI Assistant state
  showAiAssistant = false;
  aiMessages: ScheduleAssistantMessage[] = [];
  aiUserInput = '';
  aiLoading = false;
  aiError = '';
  selectedSlot: SuggestedSlot | null = null;

  interviewTypes = [
    { value: 'phone', label: 'Phone Interview' },
    { value: 'video', label: 'Video Interview' },
    { value: 'onsite', label: 'Onsite Interview' },
    { value: 'technical', label: 'Technical Interview' },
    { value: 'behavioral', label: 'Behavioral Interview' },
    { value: 'panel', label: 'Panel Interview' },
    { value: 'other', label: 'Other' }
  ];

  durations = [
    { value: 15, label: '15 minutes' },
    { value: 30, label: '30 minutes' },
    { value: 45, label: '45 minutes' },
    { value: 60, label: '1 hour' },
    { value: 90, label: '1.5 hours' },
    { value: 120, label: '2 hours' }
  ];

  constructor(private interviewService: InterviewService) {}

  ngOnInit() {
    // Set default timezone to America/New_York
    this.timezone = 'America/New_York';

    // Set default title
    if (this.application) {
      this.title = `${this.application.job_title || 'Interview'} at ${this.application.company_name || 'Company'}`;
    }

    // Set default date to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    this.scheduledDate = tomorrow.toISOString().split('T')[0];
    this.scheduledTime = '10:00';

    // Populate from existing interview if editing
    if (this.existingInterview) {
      this.populateFromExisting();
    }
  }

  private populateFromExisting() {
    const interview = this.existingInterview!;
    this.title = interview.title;
    this.interviewType = interview.interview_type;
    this.duration = interview.duration_minutes;
    this.timezone = interview.timezone;
    this.location = interview.location || '';
    this.meetingLink = interview.meeting_link || '';
    this.interviewerName = interview.interviewer_name || '';
    this.interviewerEmail = interview.interviewer_email || '';
    this.notes = interview.notes || '';

    // Parse scheduled date and time
    const date = new Date(interview.scheduled_at);
    this.scheduledDate = date.toISOString().split('T')[0];
    this.scheduledTime = date.toTimeString().slice(0, 5);
  }

  async scheduleInterview() {
    if (!this.scheduledDate || !this.scheduledTime) {
      this.error = 'Please select a date and time';
      return;
    }

    this.saving = true;
    this.error = '';

    try {
      // Convert date/time from America/New_York to UTC for storage
      const scheduledAt = this.convertToUTC(this.scheduledDate, this.scheduledTime, this.timezone);

      const request: CreateInterviewRequest = {
        application_id: this.application.id,
        title: this.title,
        interview_type: this.interviewType,
        scheduled_at: scheduledAt,
        duration_minutes: this.duration,
        timezone: this.timezone,
        location: this.location || undefined,
        meeting_link: this.meetingLink || undefined,
        interviewer_name: this.interviewerName || undefined,
        interviewer_email: this.interviewerEmail || undefined,
        notes: this.notes || undefined,
        add_to_google_calendar: this.addToGoogleCalendar
      };

      let interview: ScheduledInterview;

      if (this.existingInterview) {
        // Update existing
        interview = await this.interviewService.updateInterview(this.existingInterview.id, {
          title: request.title,
          interview_type: request.interview_type,
          scheduled_at: request.scheduled_at,
          duration_minutes: request.duration_minutes,
          timezone: request.timezone,
          location: request.location,
          meeting_link: request.meeting_link,
          interviewer_name: request.interviewer_name,
          interviewer_email: request.interviewer_email,
          notes: request.notes
        });
      } else {
        // Create new
        interview = await this.interviewService.scheduleInterview(request);
      }

      this.saved.emit(interview);
    } catch (err: any) {
      console.error('Failed to schedule interview:', err);
      this.error = err.message || 'Failed to schedule interview';
    } finally {
      this.saving = false;
    }
  }

  closeModal() {
    this.close.emit();
  }

  get minDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  get isEditing(): boolean {
    return !!this.existingInterview;
  }

  // ============================================================================
  // AI SCHEDULING ASSISTANT
  // ============================================================================

  toggleAiAssistant() {
    this.showAiAssistant = !this.showAiAssistant;

    // Show welcome message on first open
    if (this.showAiAssistant && this.aiMessages.length === 0) {
      this.aiMessages.push({
        role: 'assistant',
        content: `Hi! I can help you find the best time to schedule this interview. Try asking me:\n\n• "Find me a slot this Friday afternoon"\n• "When is the best time for a ${this.duration}-minute interview next week?"\n• "What times are available between 2PM and 5PM tomorrow?"`,
        timestamp: new Date()
      });
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

    try {
      // Build conversation history for context
      const conversationHistory = this.aiMessages
        .filter(m => !m.suggestedSlots || m.suggestedSlots.length === 0)
        .map(m => ({ role: m.role, content: m.content }));

      const response = await this.interviewService.getSchedulingSuggestions({
        userMessage,
        duration: this.duration,
        dateRange: this.interviewService.getDateRangeForScheduling(14),
        timezone: this.timezone,
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
        content: 'Sorry, I encountered an error while checking availability. Please try again or select a time manually.',
        timestamp: new Date()
      });
    } finally {
      this.aiLoading = false;
    }
  }

  selectSuggestedSlot(slot: SuggestedSlot) {
    // If clicking the same slot, do nothing (already selected)
    if (this.isSlotSelected(slot)) return;

    this.selectedSlot = slot;
    this.scheduledDate = slot.date;
    this.scheduledTime = slot.startTime;

    // Add confirmation message
    this.aiMessages.push({
      role: 'assistant',
      content: `Great choice! I've set the interview for ${this.formatSlotDisplay(slot)}. You can adjust the other details and save when ready.`,
      timestamp: new Date()
    });
  }

  isSlotSelected(slot: SuggestedSlot): boolean {
    if (!this.selectedSlot) return false;
    return this.selectedSlot.date === slot.date &&
           this.selectedSlot.startTime === slot.startTime &&
           this.selectedSlot.endTime === slot.endTime;
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

  onAiInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendAiMessage();
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
}
