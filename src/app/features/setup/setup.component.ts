import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService } from '../../core/services/supabase.service';

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './setup.component.html',
  styleUrls: ['./setup.component.scss']
})
export class SetupComponent implements OnInit {
  setupForm: FormGroup;
  loading = false;
  checking = true;
  error = '';
  
  // Invitation
  hasInvitation = false;
  invitation: any = null;

  constructor(
    private fb: FormBuilder,
    private supabase: SupabaseService,
    private router: Router
  ) {
    this.setupForm = this.fb.group({
      organizationName: ['', [Validators.required, Validators.minLength(2)]]
    });
  }

  async ngOnInit() {
    await this.checkStatus();
  }

  private async checkStatus() {
    try {
      // Check if user already has an organization
      const profile = await this.supabase.getProfile();
      if (profile?.organization_id) {
        this.redirectBasedOnRole(profile.role);
        return;
      }

      // Check for pending invitation
      const invite = await this.supabase.getPendingInvitation();
      if (invite) {
        this.hasInvitation = true;
        this.invitation = invite;
      }
    } catch (err) {
      console.error('Error checking status:', err);
    } finally {
      this.checking = false;
    }
  }

  async acceptInvitation() {
    this.loading = true;
    this.error = '';

    try {
      await this.supabase.acceptInvitation();
      const profile = await this.supabase.getProfile();
      this.redirectBasedOnRole(profile?.role || 'recruiter');
    } catch (err: any) {
      console.error('Accept invitation error:', err);
      this.error = err.message || 'Failed to accept invitation';
    } finally {
      this.loading = false;
    }
  }

  async onSubmit() {
    if (this.setupForm.invalid) return;

    this.loading = true;
    this.error = '';

    try {
      const { organizationName } = this.setupForm.value;
      await this.supabase.createOrganization(organizationName);
      const profile = await this.supabase.getProfile();
      this.redirectBasedOnRole(profile?.role || 'recruiter');
    } catch (err: any) {
      this.error = err.message || 'Failed to create organization';
    } finally {
      this.loading = false;
    }
  }

  private redirectBasedOnRole(role: string | null) {
    if (role === 'admin') {
      this.router.navigate(['/admin']);
    } else {
      this.router.navigate(['/dashboard']);
    }
  }
}