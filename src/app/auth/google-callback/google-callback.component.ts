import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-google-callback',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="callback-container">
      <div class="callback-card">
        <div class="spinner"></div>
        <p>{{ message }}</p>
      </div>
    </div>
  `,
  styles: [`
    .callback-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fafafa;
    }
    .callback-card {
      background: white;
      padding: 40px;
      border-radius: 12px;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #e5e5e5;
      border-top-color: #635BFF;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    p {
      color: #666;
      margin: 0;
    }
  `]
})
export class GoogleCallbackComponent implements OnInit {
  message = 'Redirecting...';

  ngOnInit() {
    // Since we're using service account, this page is not needed
    // Just redirect to dashboard
    setTimeout(() => {
      window.location.href = '/dashboard';
    }, 1000);
  }
}
