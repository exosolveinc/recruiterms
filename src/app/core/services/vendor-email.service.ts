import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { firstValueFrom } from 'rxjs';

export interface VendorJob {
  id: string;
  user_id: string;
  vendor_id?: string;
  vendor_contact_id?: string;

  // Email metadata
  email_id?: string;
  email_subject?: string;
  email_from: string;
  email_received_at?: string;

  // Job details
  job_title: string;
  client_company?: string;
  location?: string;
  work_arrangement: 'onsite' | 'remote' | 'hybrid' | 'unknown';
  employment_type: 'w2' | 'c2c' | '1099' | 'full_time' | 'contract' | 'contract_to_hire' | 'part_time' | 'unknown';
  duration?: string;

  // Compensation
  pay_rate?: string;
  pay_rate_min?: number;
  pay_rate_max?: number;
  pay_rate_type?: string;

  // Requirements
  required_skills: string[];
  years_experience?: string;
  certifications: string[];
  special_requirements?: string;

  // Tech stack
  tech_stack?: {
    frontend?: string[];
    backend?: string[];
    cloud?: string[];
    other?: string[];
  };

  // Description
  job_description?: string;

  // Recruiter info
  recruiter_name?: string;
  recruiter_email?: string;
  recruiter_phone?: string;
  recruiter_title?: string;

  // Status
  is_interested?: boolean;
  is_applied: boolean;
  applied_at?: string;
  application_id?: string;
  status: 'new' | 'reviewed' | 'interested' | 'not_interested' | 'applied' | 'expired' | 'archived';
  notes?: string;

  // Extraction info
  extraction_confidence?: number;

  // Timestamps
  created_at: string;
  updated_at: string;

  // Joined vendor info (from view)
  vendor_company?: string;
  vendor_website?: string;
  vendor_rating?: number;
  vendor_blocked?: boolean;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;

  // Source Gmail account (from view)
  candidate_id?: string;
  gmail_connection_id?: string;
  source_gmail?: string;
}

export interface Vendor {
  id: string;
  user_id: string;
  company_name: string;
  website?: string;
  emails_received: number;
  jobs_posted: number;
  rating?: number;
  notes?: string;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

export interface VendorContact {
  id: string;
  vendor_id: string;
  user_id: string;
  name: string;
  title?: string;
  email: string;
  phone?: string;
  linkedin_url?: string;
  emails_sent: number;
  last_contact_at?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface VendorJobStats {
  total_jobs: number;
  new_jobs: number;
  interested_jobs: number;
  applied_jobs: number;
  total_vendors: number;
  jobs_this_week: number;
}

export interface GmailConnectionStatus {
  connected: boolean;
  connection_id?: string;
  candidate_id?: string;
  google_email?: string;
  is_active?: boolean;
  last_sync_at?: string;
  last_sync_status?: string;
  emails_synced_count?: number;
  auto_sync_enabled?: boolean;
  connections_count?: number; // Number of Gmail accounts for this candidate
}

export interface CandidateGmailAccount {
  connection_id: string;
  google_email: string;
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  emails_synced_count: number;
  auto_sync_enabled: boolean;
  created_at: string;
}

export interface CandidateEmailStats {
  total_emails: number;
  job_emails: number;
  new_jobs: number;
  interested_jobs: number;
  applied_jobs: number;
  last_sync_at: string | null;
  gmail_count?: number; // Number of Gmail accounts connected
}

export interface GmailSyncResult {
  success: boolean;
  emailsFound: number;
  emailsParsed: number;
  emailsSkipped: number;
  jobsCreated: number;
  errors?: string[];
}

export interface ParseEmailRequest {
  emailBody: string;
  emailSubject?: string;
  emailFrom?: string;
  emailReceivedAt?: string;
  emailId?: string;
}

@Injectable({
  providedIn: 'root'
})
export class VendorEmailService {
  private supabaseFunctionsUrl = `${environment.supabaseUrl}/functions/v1`;
  private supabase: any = null;

  constructor(private http: HttpClient) {
    this.initSupabase();
  }

  private async initSupabase() {
    const { createClient } = await import('@supabase/supabase-js');
    this.supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);
  }

  private async getHeaders(): Promise<HttpHeaders> {
    // Get the user's session token for authenticated requests
    if (!this.supabase) {
      await this.initSupabase();
    }

    const { data: { session } } = await this.supabase.auth.getSession();
    const token = session?.access_token || environment.supabaseAnonKey;

    return new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    });
  }

  /**
   * Parse a vendor email and extract job information
   */
  async parseVendorEmail(request: ParseEmailRequest): Promise<{ success: boolean; job: VendorJob; parsed: any }> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.post<{ success: boolean; job: VendorJob; parsed: any }>(
        `${this.supabaseFunctionsUrl}/parse-vendor-email`,
        request,
        { headers }
      )
    );
    return response;
  }

  /**
   * Get all vendor jobs for the current user
   */
  async getVendorJobs(options?: {
    status?: string;
    vendorId?: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<VendorJob[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    let query = supabase
      .from('vendor_job_email_details')
      .select('*')
      .order('created_at', { ascending: false });

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    if (options?.vendorId) {
      query = query.eq('vendor_id', options.vendorId);
    }

    if (options?.search) {
      query = query.or(`job_title.ilike.%${options.search}%,client_company.ilike.%${options.search}%,vendor_company.ilike.%${options.search}%`);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching vendor jobs:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Get a single vendor job by ID
   */
  async getVendorJob(id: string): Promise<VendorJob | null> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase
      .from('vendor_job_email_details')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching vendor job:', error);
      return null;
    }

    return data;
  }

  /**
   * Update vendor job status
   */
  async updateVendorJobStatus(id: string, status: VendorJob['status'], notes?: string): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const updateData: any = { status };
    if (notes !== undefined) {
      updateData.notes = notes;
    }
    if (status === 'interested') {
      updateData.is_interested = true;
    }

    const { error } = await supabase
      .from('vendor_job_emails')
      .update(updateData)
      .eq('id', id);

    if (error) {
      console.error('Error updating vendor job:', error);
      throw error;
    }
  }

  /**
   * Mark vendor job as applied
   */
  async markAsApplied(id: string, applicationId?: string): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { error } = await supabase
      .from('vendor_job_emails')
      .update({
        status: 'applied',
        is_applied: true,
        applied_at: new Date().toISOString(),
        application_id: applicationId
      })
      .eq('id', id);

    if (error) {
      console.error('Error marking job as applied:', error);
      throw error;
    }
  }

  /**
   * Delete a vendor job
   */
  async deleteVendorJob(id: string): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { error } = await supabase
      .from('vendor_job_emails')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting vendor job:', error);
      throw error;
    }
  }

  /**
   * Get vendor job stats
   */
  async getVendorJobStats(): Promise<VendorJobStats> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase.rpc('get_vendor_job_stats');

    if (error) {
      console.error('Error fetching vendor job stats:', error);
      return {
        total_jobs: 0,
        new_jobs: 0,
        interested_jobs: 0,
        applied_jobs: 0,
        total_vendors: 0,
        jobs_this_week: 0
      };
    }

    return data?.[0] || {
      total_jobs: 0,
      new_jobs: 0,
      interested_jobs: 0,
      applied_jobs: 0,
      total_vendors: 0,
      jobs_this_week: 0
    };
  }

  /**
   * Get all vendors
   */
  async getVendors(): Promise<Vendor[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .order('jobs_posted', { ascending: false });

    if (error) {
      console.error('Error fetching vendors:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Update vendor rating
   */
  async updateVendorRating(vendorId: string, rating: number): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { error } = await supabase
      .from('vendors')
      .update({ rating })
      .eq('id', vendorId);

    if (error) {
      console.error('Error updating vendor rating:', error);
      throw error;
    }
  }

  /**
   * Block/unblock a vendor
   */
  async toggleVendorBlock(vendorId: string, isBlocked: boolean): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { error } = await supabase
      .from('vendors')
      .update({ is_blocked: isBlocked })
      .eq('id', vendorId);

    if (error) {
      console.error('Error toggling vendor block:', error);
      throw error;
    }
  }

  /**
   * Get vendor contacts
   */
  async getVendorContacts(vendorId: string): Promise<VendorContact[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase
      .from('vendor_contacts')
      .select('*')
      .eq('vendor_id', vendorId)
      .order('last_contact_at', { ascending: false });

    if (error) {
      console.error('Error fetching vendor contacts:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Format employment type for display
   */
  formatEmploymentType(type: string): string {
    const types: Record<string, string> = {
      'w2': 'W2',
      'c2c': 'C2C',
      '1099': '1099',
      'full_time': 'Full Time',
      'contract': 'Contract',
      'contract_to_hire': 'Contract to Hire',
      'part_time': 'Part Time',
      'unknown': 'Unknown'
    };
    return types[type] || type;
  }

  /**
   * Format work arrangement for display
   */
  formatWorkArrangement(arrangement: string): string {
    const arrangements: Record<string, string> = {
      'onsite': 'Onsite',
      'remote': 'Remote',
      'hybrid': 'Hybrid',
      'unknown': 'Unknown'
    };
    return arrangements[arrangement] || arrangement;
  }

  /**
   * Get status badge class
   */
  getStatusClass(status: string): string {
    const classes: Record<string, string> = {
      'new': 'status-new',
      'reviewed': 'status-reviewed',
      'interested': 'status-interested',
      'not_interested': 'status-not-interested',
      'applied': 'status-applied',
      'expired': 'status-expired',
      'archived': 'status-archived'
    };
    return classes[status] || '';
  }

  // ============================================================================
  // GMAIL INTEGRATION METHODS
  // ============================================================================

  /**
   * Get Gmail authorization URL to start OAuth flow for a specific candidate
   */
  async getGmailAuthUrl(candidateId: string): Promise<{ authUrl: string; state: string }> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.get<{ authUrl: string; state: string }>(
        `${this.supabaseFunctionsUrl}/gmail-oauth?action=authorize&candidateId=${encodeURIComponent(candidateId)}`,
        { headers }
      )
    );
    return response;
  }

  /**
   * Complete Gmail OAuth callback and save tokens for a candidate
   */
  async completeGmailAuth(code: string, state: string, candidateId?: string): Promise<{ success: boolean; email: string; name: string }> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.post<{ success: boolean; email: string; name: string }>(
        `${this.supabaseFunctionsUrl}/gmail-oauth?action=callback`,
        { code, state, candidateId },
        { headers }
      )
    );
    return response;
  }

  /**
   * Get Gmail connection status for a specific candidate (returns first/primary connection)
   */
  async getCandidateGmailStatus(candidateId: string): Promise<GmailConnectionStatus> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('get_candidate_gmail_status', {
        p_candidate_id: candidateId
      });

      if (error || !data || data.length === 0) {
        return { connected: false, connections_count: 0 };
      }

      const connection = data[0];
      return {
        connected: connection.is_connected,
        connection_id: connection.connection_id,
        candidate_id: candidateId,
        google_email: connection.google_email,
        is_active: connection.is_connected,
        last_sync_at: connection.last_sync_at,
        last_sync_status: connection.last_sync_status,
        emails_synced_count: connection.emails_synced_count,
        auto_sync_enabled: connection.auto_sync_enabled,
        connections_count: connection.connections_count || 1
      };
    } catch (error) {
      console.error('Candidate Gmail status error:', error);
      return { connected: false, connections_count: 0 };
    }
  }

  /**
   * Get all Gmail accounts for a specific candidate (up to 3)
   */
  async getCandidateGmailAccounts(candidateId: string): Promise<CandidateGmailAccount[]> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('get_candidate_gmail_connections', {
        p_candidate_id: candidateId
      });

      if (error || !data) {
        console.error('Error fetching candidate Gmail accounts:', error);
        return [];
      }

      return data.map((conn: any) => ({
        connection_id: conn.connection_id,
        google_email: conn.google_email,
        is_active: conn.is_active,
        last_sync_at: conn.last_sync_at,
        last_sync_status: conn.last_sync_status,
        emails_synced_count: conn.emails_synced_count,
        auto_sync_enabled: conn.auto_sync_enabled,
        created_at: conn.created_at
      }));
    } catch (error) {
      console.error('Error fetching candidate Gmail accounts:', error);
      return [];
    }
  }

  /**
   * Check if candidate can add more Gmail accounts
   */
  async canAddGmailForCandidate(candidateId: string): Promise<{ canAdd: boolean; currentCount: number; maxAllowed: number }> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('can_add_gmail_for_candidate', {
        p_candidate_id: candidateId
      });

      if (error || !data || data.length === 0) {
        return { canAdd: true, currentCount: 0, maxAllowed: 3 };
      }

      return {
        canAdd: data[0].can_add,
        currentCount: data[0].current_count,
        maxAllowed: data[0].max_allowed
      };
    } catch (error) {
      console.error('Error checking Gmail limit:', error);
      return { canAdd: true, currentCount: 0, maxAllowed: 3 };
    }
  }

  /**
   * Disconnect a specific Gmail account by connection ID
   */
  async disconnectGmailConnection(connectionId: string): Promise<boolean> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('disconnect_gmail_connection', {
        p_connection_id: connectionId
      });

      if (error) {
        console.error('Error disconnecting Gmail:', error);
        return false;
      }

      return data === true;
    } catch (error) {
      console.error('Error disconnecting Gmail:', error);
      return false;
    }
  }

  /**
   * Sync emails from a specific Gmail connection
   */
  async syncGmailConnection(connectionId: string, options?: {
    syncType?: 'full' | 'incremental' | 'manual';
    maxEmails?: number;
    syncAll?: boolean
  }): Promise<GmailSyncResult> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.post<GmailSyncResult>(
        `${this.supabaseFunctionsUrl}/gmail-sync`,
        {
          connectionId,
          syncType: options?.syncType || 'manual',
          maxEmails: options?.maxEmails || 50,
          syncAll: options?.syncAll || false
        },
        { headers }
      )
    );
    return response;
  }

  /**
   * Get Gmail connection status (legacy - for backward compatibility)
   */
  async getGmailStatus(): Promise<GmailConnectionStatus> {
    try {
      const headers = await this.getHeaders();
      const response = await firstValueFrom(
        this.http.get<GmailConnectionStatus>(
          `${this.supabaseFunctionsUrl}/gmail-oauth?action=status`,
          { headers }
        )
      );
      return response;
    } catch (error) {
      console.error('Gmail status error:', error);
      return { connected: false };
    }
  }

  /**
   * Get all Gmail connections for the current user
   */
  async getAllGmailConnections(): Promise<GmailConnectionStatus[]> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('get_all_gmail_connections');

      if (error) {
        console.error('Error fetching all Gmail connections:', error);
        return [];
      }

      return (data || []).map((conn: any) => ({
        connected: conn.is_active,
        connection_id: conn.id,
        candidate_id: conn.candidate_id,
        google_email: conn.google_email,
        is_active: conn.is_active,
        last_sync_at: conn.last_sync_at,
        last_sync_status: conn.last_sync_status,
        emails_synced_count: conn.emails_synced_count,
        auto_sync_enabled: conn.auto_sync_enabled
      }));
    } catch (error) {
      console.error('Error getting all Gmail connections:', error);
      return [];
    }
  }

  /**
   * Disconnect Gmail account for a specific candidate
   */
  async disconnectCandidateGmail(candidateId: string): Promise<void> {
    const headers = await this.getHeaders();
    await firstValueFrom(
      this.http.get(
        `${this.supabaseFunctionsUrl}/gmail-oauth?action=disconnect&candidateId=${encodeURIComponent(candidateId)}`,
        { headers }
      )
    );
  }

  /**
   * Disconnect Gmail account (legacy - for backward compatibility)
   */
  async disconnectGmail(): Promise<void> {
    const headers = await this.getHeaders();
    await firstValueFrom(
      this.http.get(
        `${this.supabaseFunctionsUrl}/gmail-oauth?action=disconnect`,
        { headers }
      )
    );
  }

  /**
   * Sync emails from Gmail for a specific candidate
   */
  async syncCandidateEmails(candidateId: string, options?: {
    syncType?: 'full' | 'incremental' | 'manual';
    maxEmails?: number;
    syncAll?: boolean
  }): Promise<GmailSyncResult> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.post<GmailSyncResult>(
        `${this.supabaseFunctionsUrl}/gmail-sync`,
        {
          candidateId,
          syncType: options?.syncType || 'manual',
          maxEmails: options?.maxEmails || 50,
          syncAll: options?.syncAll || false
        },
        { headers }
      )
    );
    return response;
  }

  /**
   * Sync emails from Gmail (legacy - for backward compatibility)
   */
  async syncGmailEmails(options?: { syncType?: 'full' | 'incremental' | 'manual'; maxEmails?: number; syncAll?: boolean }): Promise<GmailSyncResult> {
    const headers = await this.getHeaders();
    const response = await firstValueFrom(
      this.http.post<GmailSyncResult>(
        `${this.supabaseFunctionsUrl}/gmail-sync`,
        {
          syncType: options?.syncType || 'manual',
          maxEmails: options?.maxEmails || 50,
          syncAll: options?.syncAll || false
        },
        { headers }
      )
    );
    return response;
  }

  /**
   * Get vendor jobs for a specific candidate
   */
  async getCandidateVendorJobs(candidateId: string, options?: {
    status?: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<VendorJob[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    let query = supabase
      .from('vendor_job_email_details')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('created_at', { ascending: false });

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    if (options?.search) {
      query = query.or(`job_title.ilike.%${options.search}%,client_company.ilike.%${options.search}%,vendor_company.ilike.%${options.search}%`);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching candidate vendor jobs:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Get email statistics for a specific candidate
   */
  async getCandidateEmailStats(candidateId: string): Promise<CandidateEmailStats> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

      const { data, error } = await supabase.rpc('get_candidate_email_stats', {
        p_candidate_id: candidateId
      });

      if (error || !data || data.length === 0) {
        return {
          total_emails: 0,
          job_emails: 0,
          new_jobs: 0,
          interested_jobs: 0,
          applied_jobs: 0,
          last_sync_at: null
        };
      }

      return data[0];
    } catch (error) {
      console.error('Error fetching candidate email stats:', error);
      return {
        total_emails: 0,
        job_emails: 0,
        new_jobs: 0,
        interested_jobs: 0,
        applied_jobs: 0,
        last_sync_at: null
      };
    }
  }

  /**
   * Get Gmail sync history for a specific candidate
   */
  async getCandidateSyncHistory(candidateId: string, limit = 10): Promise<any[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase
      .from('gmail_sync_logs')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching candidate sync history:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Get Gmail sync history (legacy - for backward compatibility)
   */
  async getGmailSyncHistory(limit = 10): Promise<any[]> {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

    const { data, error } = await supabase
      .from('gmail_sync_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching sync history:', error);
      return [];
    }

    return data || [];
  }
}
