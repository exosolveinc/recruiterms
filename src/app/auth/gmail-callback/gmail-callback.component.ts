import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { VendorEmailService } from '../../core/services/vendor-email.service';
import { SupabaseService } from '../../core/services/supabase.service';

@Component({
  selector: 'app-gmail-callback',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="callback-container">
      <div class="callback-card">
        <div *ngIf="isProcessing" class="processing">
          <div class="spinner"></div>
          <h2>Connecting Gmail...</h2>
          <p>Please wait while we complete the authorization.</p>
        </div>

        <div *ngIf="error" class="error">
          <div class="error-icon">✕</div>
          <h2>Connection Failed</h2>
          <p>{{ error }}</p>
          <button (click)="goToJobFeed()" class="btn-primary">Go to Job Feed</button>
        </div>

        <div *ngIf="success" class="success">
          <div class="success-icon">✓</div>
          <h2>Gmail Connected!</h2>
          <p>Successfully connected {{ connectedEmail }}</p>
          <p class="redirect-msg">Redirecting to Job Feed...</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .callback-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
    }

    .callback-card {
      background: white;
      border-radius: 16px;
      padding: 48px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }

    .processing h2, .error h2, .success h2 {
      margin: 16px 0 8px;
      color: #1a1a2e;
    }

    .processing p, .error p, .success p {
      color: #666;
      margin: 0;
    }

    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #e0e0e0;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-icon {
      width: 48px;
      height: 48px;
      background: #ff4757;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: bold;
      margin: 0 auto;
    }

    .success-icon {
      width: 48px;
      height: 48px;
      background: #2ed573;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: bold;
      margin: 0 auto;
    }

    .btn-primary {
      margin-top: 24px;
      padding: 12px 32px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .redirect-msg {
      margin-top: 16px !important;
      font-size: 14px;
      color: #999 !important;
    }
  `]
})
export class GmailCallbackComponent implements OnInit {
  isProcessing = true;
  error: string | null = null;
  success = false;
  connectedEmail = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private vendorEmailService: VendorEmailService,
    private supabaseService: SupabaseService
  ) {}

  async ngOnInit() {
    // First check if user is authenticated
    const session = await this.waitForSession();

    if (!session) {
      // Store the callback params and redirect to login
      const code = this.route.snapshot.queryParamMap.get('code');
      const state = this.route.snapshot.queryParamMap.get('state');

      if (code && state) {
        // Store in sessionStorage to process after login
        sessionStorage.setItem('gmail_oauth_code', code);
        sessionStorage.setItem('gmail_oauth_state', state);
      }

      this.router.navigate(['/auth/login']);
      return;
    }

    // Process the OAuth callback
    const code = this.route.snapshot.queryParamMap.get('code');
    const state = this.route.snapshot.queryParamMap.get('state');

    if (!code || !state) {
      this.error = 'Missing authorization code. Please try connecting Gmail again.';
      this.isProcessing = false;
      return;
    }

    try {
      const result = await this.vendorEmailService.completeGmailAuth(code, state);

      if (result.success) {
        this.success = true;
        this.connectedEmail = result.email;
        this.isProcessing = false;

        // Redirect to job feed after a short delay
        setTimeout(() => {
          this.router.navigate(['/job-feed'], {
            queryParams: { gmail: 'connected' }
          });
        }, 2000);
      } else {
        this.error = 'Failed to connect Gmail. Please try again.';
        this.isProcessing = false;
      }
    } catch (err: any) {
      console.error('Gmail auth error:', err);
      this.error = err.message || 'Failed to connect Gmail. Please try again.';
      this.isProcessing = false;
    }
  }

  private waitForSession(): Promise<any> {
    return new Promise((resolve) => {
      // First try to get session directly
      this.supabaseService.session$.subscribe(session => {
        if (session) {
          resolve(session);
        }
      });

      // Also set a timeout to avoid waiting forever
      setTimeout(() => {
        resolve(null);
      }, 3000);
    });
  }

  goToJobFeed() {
    this.router.navigate(['/job-feed']);
  }
}
