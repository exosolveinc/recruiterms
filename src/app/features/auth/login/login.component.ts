import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SupabaseService } from '../../../core/services/supabase.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  loginForm: FormGroup;
  loading = false;
  error = '';

  constructor(
    private fb: FormBuilder,
    private supabase: SupabaseService,
    private router: Router
  ) {
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required]]
    });
  }

  async onSubmit() {
    if (this.loginForm.invalid) return;

    this.loading = true;
    this.error = '';

    try {
      const { email, password } = this.loginForm.value;
      
      // Step 1: Sign in
      await this.supabase.signIn(email, password);

      // Step 2: Get profile to check role and organization
      const profile = await this.supabase.getProfile();

      // Step 3: Redirect based on profile status and role
      if (!profile?.organization_id) {
        // New user - needs setup
        this.router.navigate(['/setup']);
      } else if (profile.role === 'admin') {
        // Admin user
        this.router.navigate(['/admin']);
      } else {
        // Regular recruiter
        this.router.navigate(['/dashboard']);
      }

    } catch (err: any) {
      console.error('Login error:', err);
      this.error = err.message || 'Invalid email or password';
    } finally {
      this.loading = false;
    }
  }
}