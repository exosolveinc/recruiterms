import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SupabaseService } from './supabase.service';

export interface ScheduledInterview {
  id: string;
  application_id: string;
  user_id: string;
  organization_id: string | null;
  title: string;
  interview_type: 'phone' | 'video' | 'onsite' | 'technical' | 'behavioral' | 'panel' | 'other';
  scheduled_at: string;
  duration_minutes: number;
  timezone: string;
  location?: string;
  meeting_link?: string;
  interviewer_name?: string;
  interviewer_email?: string;
  notes?: string;
  google_event_id?: string;
  google_event_link?: string;
  reminder_sent: boolean;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled' | 'no_show';
  outcome?: string;
  feedback?: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  job_title?: string;
  company_name?: string;
  candidate_name?: string;
}

export interface CreateInterviewRequest {
  application_id: string;
  title: string;
  interview_type: ScheduledInterview['interview_type'];
  scheduled_at: string;
  duration_minutes: number;
  timezone: string;
  location?: string;
  meeting_link?: string;
  interviewer_name?: string;
  interviewer_email?: string;
  notes?: string;
  add_to_google_calendar?: boolean;
}

// AI Scheduling Assistant types
export interface SuggestedSlot {
  date: string;
  startTime: string;
  endTime: string;
  datetime: string;
  reason: string;
}

export interface ScheduleAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  suggestedSlots?: SuggestedSlot[];
  timestamp: Date;
}

export interface ScheduleAssistantRequest {
  userMessage: string;
  duration: number;
  dateRange: {
    start: string;
    end: string;
  };
  timezone: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ScheduleAssistantResponse {
  message: string;
  suggestedSlots: SuggestedSlot[];
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class InterviewService {
  private supabaseFunctionsUrl = `${environment.supabaseUrl}/functions/v1`;

  constructor(
    private http: HttpClient,
    private supabase: SupabaseService
  ) {}

  // ============================================================================
  // GOOGLE CALENDAR (via Service Account Edge Function)
  // ============================================================================

  /**
   * Create a Google Calendar event using service account
   */
  private async createGoogleCalendarEvent(
    interview: CreateInterviewRequest,
    jobTitle: string,
    companyName: string
  ): Promise<{ eventId: string; htmlLink: string } | null> {
    const startDate = new Date(interview.scheduled_at);
    const endDate = new Date(startDate.getTime() + interview.duration_minutes * 60 * 1000);

    const description = this.buildEventDescription(interview, jobTitle, companyName);

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${environment.supabaseAnonKey}`
    });

    try {
      const response: any = await firstValueFrom(
        this.http.post(`${this.supabaseFunctionsUrl}/create-calendar-event`, {
          action: 'create',
          title: `Interview: ${jobTitle} at ${companyName}`,
          description: description,
          startTime: startDate.toISOString(),
          endTime: endDate.toISOString(),
          timezone: interview.timezone,
          location: interview.meeting_link || interview.location,
          attendees: interview.interviewer_email ? [interview.interviewer_email] : []
        }, { headers })
      );

      if (response.success) {
        return {
          eventId: response.eventId,
          htmlLink: response.htmlLink
        };
      }

      console.error('Calendar event creation failed:', response.error);
      return null;
    } catch (error) {
      console.error('Failed to create Google Calendar event:', error);
      return null;
    }
  }

  /**
   * Update a Google Calendar event
   */
  private async updateGoogleCalendarEvent(
    eventId: string,
    interview: Partial<CreateInterviewRequest>,
    title?: string
  ): Promise<boolean> {
    if (!eventId) return false;

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${environment.supabaseAnonKey}`
    });

    try {
      const startDate = interview.scheduled_at ? new Date(interview.scheduled_at) : null;
      const endDate = startDate && interview.duration_minutes
        ? new Date(startDate.getTime() + interview.duration_minutes * 60 * 1000)
        : null;

      const response: any = await firstValueFrom(
        this.http.post(`${this.supabaseFunctionsUrl}/create-calendar-event`, {
          action: 'update',
          eventId: eventId,
          title: title || 'Interview',
          description: '',
          startTime: startDate?.toISOString(),
          endTime: endDate?.toISOString(),
          timezone: interview.timezone || 'America/New_York',
          location: interview.meeting_link || interview.location
        }, { headers })
      );

      return response.success;
    } catch (error) {
      console.error('Failed to update Google Calendar event:', error);
      return false;
    }
  }

  /**
   * Delete a Google Calendar event
   */
  private async deleteGoogleCalendarEvent(eventId: string): Promise<boolean> {
    if (!eventId) return false;

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${environment.supabaseAnonKey}`
    });

    try {
      const response: any = await firstValueFrom(
        this.http.post(`${this.supabaseFunctionsUrl}/create-calendar-event`, {
          action: 'delete',
          eventId: eventId,
          title: '',
          description: '',
          startTime: '',
          endTime: '',
          timezone: ''
        }, { headers })
      );

      return response.success;
    } catch (error) {
      console.error('Failed to delete Google Calendar event:', error);
      return false;
    }
  }

  private buildEventDescription(
    interview: CreateInterviewRequest,
    jobTitle: string,
    companyName: string
  ): string {
    let description = `Interview for ${jobTitle} position at ${companyName}\n\n`;
    description += `Type: ${this.formatInterviewType(interview.interview_type)}\n`;
    description += `Duration: ${interview.duration_minutes} minutes\n`;

    if (interview.interviewer_name) {
      description += `Interviewer: ${interview.interviewer_name}\n`;
    }

    if (interview.meeting_link) {
      description += `\nMeeting Link: ${interview.meeting_link}\n`;
    }

    if (interview.location) {
      description += `\nLocation: ${interview.location}\n`;
    }

    if (interview.notes) {
      description += `\nNotes:\n${interview.notes}\n`;
    }

    description += '\n---\nScheduled via Recruitment Management System';

    return description;
  }

  private formatInterviewType(type: string): string {
    const types: Record<string, string> = {
      'phone': 'Phone Interview',
      'video': 'Video Interview',
      'onsite': 'Onsite Interview',
      'technical': 'Technical Interview',
      'behavioral': 'Behavioral Interview',
      'panel': 'Panel Interview',
      'other': 'Interview'
    };
    return types[type] || type;
  }

  // ============================================================================
  // DATABASE OPERATIONS
  // ============================================================================

  /**
   * Schedule a new interview
   */
  async scheduleInterview(request: CreateInterviewRequest): Promise<ScheduledInterview> {
    const client = this.supabase.supabaseClient;
    const profile = this.supabase.currentProfile;
    const user = this.supabase.currentUser;

    if (!user) throw new Error('Not authenticated');

    // Get job details for Google Calendar event
    let googleEventId: string | null = null;
    let googleEventLink: string | null = null;

    if (request.add_to_google_calendar) {
      // Get application details first
      const { data: app } = await client
        .from('user_applications')
        .select('job_title, company_name')
        .eq('id', request.application_id)
        .single();

      if (app) {
        const calendarResult = await this.createGoogleCalendarEvent(
          request,
          app.job_title || 'Position',
          app.company_name || 'Company'
        );

        if (calendarResult) {
          googleEventId = calendarResult.eventId;
          googleEventLink = calendarResult.htmlLink;
        }
      }
    }

    const { data, error } = await client
      .from('scheduled_interviews')
      .insert({
        application_id: request.application_id,
        user_id: user.id,
        organization_id: profile?.organization_id,
        title: request.title,
        interview_type: request.interview_type,
        scheduled_at: request.scheduled_at,
        duration_minutes: request.duration_minutes,
        timezone: request.timezone,
        location: request.location,
        meeting_link: request.meeting_link,
        interviewer_name: request.interviewer_name,
        interviewer_email: request.interviewer_email,
        notes: request.notes,
        google_event_id: googleEventId,
        google_event_link: googleEventLink,
        status: 'scheduled'
      })
      .select()
      .single();

    if (error) throw error;

    // Update application status to interviewing
    await client
      .from('job_applications')
      .update({ status: 'interviewing' })
      .eq('id', request.application_id);

    // Log activity
    await this.supabase.logActivity('interview_scheduled', 'interview', data.id, {
      application_id: request.application_id,
      interview_type: request.interview_type,
      scheduled_at: request.scheduled_at,
      google_calendar: !!googleEventId
    });

    return data as ScheduledInterview;
  }

  /**
   * Get all interviews for current user
   */
  async getInterviews(): Promise<ScheduledInterview[]> {
    const client = this.supabase.supabaseClient;

    try {
      const { data, error } = await client
        .from('scheduled_interviews')
        .select('*')
        .order('scheduled_at', { ascending: true });

      if (error) {
        console.error('Failed to get interviews:', error);
        return [];
      }

      return (data || []) as ScheduledInterview[];
    } catch (err) {
      console.error('Error fetching interviews:', err);
      return [];
    }
  }

  /**
   * Get interviews for a specific application
   */
  async getInterviewsForApplication(applicationId: string): Promise<ScheduledInterview[]> {
    const client = this.supabase.supabaseClient;

    const { data, error } = await client
      .from('scheduled_interviews')
      .select('*')
      .eq('application_id', applicationId)
      .order('scheduled_at', { ascending: true });

    if (error) throw error;
    return (data || []) as ScheduledInterview[];
  }

  /**
   * Get upcoming interviews
   */
  async getUpcomingInterviews(days: number = 7): Promise<ScheduledInterview[]> {
    const client = this.supabase.supabaseClient;
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    try {
      // Simple query without joins to avoid schema cache issues
      const { data, error } = await client
        .from('scheduled_interviews')
        .select('*')
        .gte('scheduled_at', now.toISOString())
        .lte('scheduled_at', future.toISOString())
        .eq('status', 'scheduled')
        .order('scheduled_at', { ascending: true });

      if (error) {
        console.error('Failed to get upcoming interviews:', error);
        return [];
      }

      return (data || []) as ScheduledInterview[];
    } catch (err) {
      console.error('Error fetching upcoming interviews:', err);
      return [];
    }
  }

  /**
   * Update an interview
   */
  async updateInterview(id: string, updates: Partial<ScheduledInterview>): Promise<ScheduledInterview> {
    const client = this.supabase.supabaseClient;

    // Get existing interview to check for Google event
    const { data: existing } = await client
      .from('scheduled_interviews')
      .select('google_event_id, title')
      .eq('id', id)
      .single();

    // Update Google Calendar if there's an event
    if (existing?.google_event_id) {
      await this.updateGoogleCalendarEvent(
        existing.google_event_id,
        updates as any,
        updates.title || existing.title
      );
    }

    const { data, error } = await client
      .from('scheduled_interviews')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as ScheduledInterview;
  }

  /**
   * Cancel an interview
   */
  async cancelInterview(id: string): Promise<void> {
    const client = this.supabase.supabaseClient;

    // Get existing interview
    const { data: existing } = await client
      .from('scheduled_interviews')
      .select('google_event_id')
      .eq('id', id)
      .single();

    // Delete from Google Calendar
    if (existing?.google_event_id) {
      await this.deleteGoogleCalendarEvent(existing.google_event_id);
    }

    const { error } = await client
      .from('scheduled_interviews')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;

    await this.supabase.logActivity('interview_cancelled', 'interview', id);
  }

  /**
   * Mark interview as completed with feedback
   */
  async completeInterview(id: string, outcome: string, feedback?: string): Promise<void> {
    const client = this.supabase.supabaseClient;

    const { error } = await client
      .from('scheduled_interviews')
      .update({
        status: 'completed',
        outcome,
        feedback,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;

    await this.supabase.logActivity('interview_completed', 'interview', id, {
      outcome
    });
  }

  /**
   * Get interview by ID
   */
  async getInterview(id: string): Promise<ScheduledInterview | null> {
    const client = this.supabase.supabaseClient;

    const { data, error } = await client
      .from('scheduled_interviews')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return null;
    return data as ScheduledInterview;
  }

  // ============================================================================
  // AI SCHEDULING ASSISTANT
  // ============================================================================

  /**
   * Get AI-powered scheduling suggestions
   */
  async getSchedulingSuggestions(request: ScheduleAssistantRequest): Promise<ScheduleAssistantResponse> {
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${environment.supabaseAnonKey}`
    });

    try {
      const response = await firstValueFrom(
        this.http.post<ScheduleAssistantResponse>(
          `${this.supabaseFunctionsUrl}/ai-schedule-assistant`,
          request,
          { headers }
        )
      );

      return {
        message: response.message || 'Here are some available slots:',
        suggestedSlots: response.suggestedSlots || []
      };
    } catch (error: any) {
      console.error('Failed to get scheduling suggestions:', error);
      const errorMessage = error.error?.message || error.message || 'Failed to get scheduling suggestions';
      throw new Error(errorMessage);
    }
  }

  /**
   * Calculate date range for AI scheduling based on days ahead
   */
  getDateRangeForScheduling(daysAhead: number = 14): { start: string; end: string } {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + daysAhead);

    return {
      start: start.toISOString(),
      end: end.toISOString()
    };
  }
}
