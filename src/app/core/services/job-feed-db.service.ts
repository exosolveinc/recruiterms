import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { SupabaseService } from './supabase.service';
import { UnifiedJob } from '../models/unified-job.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class JobFeedDbService implements OnDestroy {
  private jobsSubject = new BehaviorSubject<UnifiedJob[]>([]);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private refreshingSubject = new BehaviorSubject<boolean>(false);
  private destroy$ = new Subject<void>();
  private realtimeChannel: RealtimeChannel | null = null;
  private currentCandidateId: string | null = null;

  jobs$ = this.jobsSubject.asObservable();
  loading$ = this.loadingSubject.asObservable();
  refreshing$ = this.refreshingSubject.asObservable();

  /** Synchronous snapshot of current jobs */
  get currentJobs(): UnifiedJob[] {
    return this.jobsSubject.value;
  }

  constructor(private supabase: SupabaseService) {}

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.unsubscribeRealtime();
  }

  /**
   * Load all jobs for a candidate from the DB
   */
  async loadJobsForCandidate(candidateId: string): Promise<void> {
    this.currentCandidateId = candidateId;
    this.loadingSubject.next(true);

    try {
      const { data, error } = await this.supabase.supabaseClient
        .from('job_feed')
        .select('*')
        .eq('candidate_id', candidateId)
        .neq('status', 'expired')
        .order('match_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (error) throw error;

      const jobs = (data || []).map((row: any) => this.mapToUnifiedJob(row));
      this.jobsSubject.next(jobs);

      // (Re)subscribe to realtime for this candidate
      this.subscribeToChanges(candidateId);
    } catch (err) {
      console.error('Failed to load jobs for candidate:', err);
      this.jobsSubject.next([]);
    } finally {
      this.loadingSubject.next(false);
    }
  }

  /**
   * Subscribe to realtime changes for a candidate's job feed
   */
  private subscribeToChanges(candidateId: string): void {
    this.unsubscribeRealtime();

    this.realtimeChannel = this.supabase.supabaseClient
      .channel(`job_feed:${candidateId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'job_feed',
          filter: `candidate_id=eq.${candidateId}`,
        },
        (payload: any) => {
          const newJob = this.mapToUnifiedJob(payload.new);
          const current = this.jobsSubject.value;
          // Prepend new job (most recent first)
          this.jobsSubject.next([newJob, ...current]);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'job_feed',
          filter: `candidate_id=eq.${candidateId}`,
        },
        (payload: any) => {
          const row = payload.new;
          const current = this.jobsSubject.value;

          // Remove expired jobs from the feed
          if (row.status === 'expired') {
            this.jobsSubject.next(current.filter((j) => j.id !== row.id));
            return;
          }

          const updatedJob = this.mapToUnifiedJob(row);
          const updated = current.map((j) =>
            j.id === updatedJob.id ? updatedJob : j
          );
          this.jobsSubject.next(updated);
        }
      )
      .subscribe();
  }

  private unsubscribeRealtime(): void {
    if (this.realtimeChannel) {
      this.supabase.supabaseClient.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }

  /**
   * Trigger a manual refresh by invoking the edge function
   */
  async triggerRefresh(candidateId: string): Promise<void> {
    this.refreshingSubject.next(true);
    try {
      const { error } = await this.supabase.supabaseClient.functions.invoke(
        'fetch-candidate-jobs',
        { body: { candidate_id: candidateId } }
      );
      if (error) {
        console.error('Refresh edge function error:', error);
      }
      // After the edge function completes, reload from DB to catch everything
      await this.loadJobsForCandidate(candidateId);
    } catch (err) {
      console.error('Failed to trigger refresh:', err);
    } finally {
      this.refreshingSubject.next(false);
    }
  }


  /**
   * Re-analyze all jobs for a candidate with a different resume
   */
  async reanalyzeForResume(candidateId: string, resumeId: string): Promise<void> {
    this.refreshingSubject.next(true);
    try {
      // Reset analysis_status to 'pending' for all candidate jobs
      const { error: resetError } = await this.supabase.supabaseClient
        .from('job_feed')
        .update({
          analysis_status: 'pending',
          match_score: null,
          matching_skills: [],
          missing_skills: [],
          recommendations: [],
          overall_assessment: null,
          analyzed_at: null,
          analysis_error: null,
          resume_id: null,
        })
        .eq('candidate_id', candidateId);

      if (resetError) {
        console.error('Failed to reset analysis:', resetError);
        return;
      }

      // Update local state immediately to show pending
      const current = this.jobsSubject.value;
      this.jobsSubject.next(
        current.map((j) => ({
          ...j,
          match_score: undefined,
          matching_skills: undefined,
          missing_skills: undefined,
          analyzed: false,
          analyzing: false,
          analysis_timestamp: undefined,
        }))
      );

      // Trigger edge function with analyze_only flag
      const { error } = await this.supabase.supabaseClient.functions.invoke(
        'fetch-candidate-jobs',
        { body: { candidate_id: candidateId, analyze_only: true } }
      );
      if (error) {
        console.error('Re-analyze edge function error:', error);
      }

      // Reload to get updated analysis results
      await this.loadJobsForCandidate(candidateId);
    } catch (err) {
      console.error('Failed to re-analyze:', err);
    } finally {
      this.refreshingSubject.next(false);
    }
  }

  /**
   * Map a DB row to the existing UnifiedJob interface
   */
  private mapToUnifiedJob(row: any): UnifiedJob {
    const isAnalyzed = row.analysis_status === 'completed';
    const isAnalyzing = row.analysis_status === 'analyzing';

    return {
      id: row.id,
      source_type: row.source_type || 'api',
      source_platform: row.source_platform || 'unknown',

      title: row.title || 'Unknown Title',
      company: row.company || 'Unknown Company',
      location: row.location || '',
      description: row.description || '',
      url: row.url || undefined,

      posted_date: row.posted_date || row.created_at,
      discovered_at: row.discovered_at || row.created_at,

      salary_min: row.salary_min ? Number(row.salary_min) : undefined,
      salary_max: row.salary_max ? Number(row.salary_max) : undefined,
      salary_text: row.salary_text || undefined,
      pay_rate_type: row.pay_rate_type || undefined,

      employment_type: row.employment_type || undefined,
      work_arrangement: this.normalizeWorkArrangement(row.work_arrangement),
      duration: row.duration || undefined,

      required_skills: row.required_skills || undefined,
      tech_stack: row.tech_stack || undefined,
      years_experience: row.years_experience || undefined,
      certifications: row.certifications || undefined,

      match_score: row.match_score != null ? Number(row.match_score) : undefined,
      matching_skills: row.matching_skills || undefined,
      missing_skills: row.missing_skills || undefined,
      recommendations: row.recommendations || undefined,
      overall_assessment: row.overall_assessment || undefined,
      analyzed: isAnalyzed,
      analyzing: isAnalyzing,
      analysis_timestamp: row.analyzed_at || undefined,

      is_new: !row.is_seen,
      is_seen: row.is_seen || false,

      // Email-specific
      vendor_job_id: row.vendor_job_id || undefined,
      recruiter_name: row.recruiter_name || undefined,
      recruiter_email: row.recruiter_email || undefined,
      recruiter_phone: row.recruiter_phone || undefined,
      vendor_company: row.vendor_company || undefined,
      client_company: row.client_company || undefined,
      email_subject: row.email_subject || undefined,
      email_received_at: row.email_received_at || undefined,
      status: row.status || undefined,
    };
  }

  private normalizeWorkArrangement(value?: string): UnifiedJob['work_arrangement'] {
    if (!value) return 'unknown';
    const lower = value.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('hybrid')) return 'hybrid';
    if (lower.includes('onsite') || lower.includes('on-site') || lower.includes('office')) return 'onsite';
    return 'unknown';
  }
}
