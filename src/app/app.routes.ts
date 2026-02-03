import { Routes } from '@angular/router';
import { AuthGuard, GuestGuard, RoleRedirectGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [RoleRedirectGuard],
    children: []
  },
  {
    path: 'auth',
    children: [
      {
        path: 'login',
        canActivate: [GuestGuard],
        loadComponent: () => import('./features/auth/login/login.component')
          .then(m => m.LoginComponent)
      },
      {
        path: 'signup',
        canActivate: [GuestGuard],
        loadComponent: () => import('./features/auth/signup/signup.component')
          .then(m => m.SignupComponent)
      },
      {
        path: 'google-callback',
        loadComponent: () => import('./auth/google-callback/google-callback.component')
          .then(m => m.GoogleCallbackComponent)
      },
      {
        path: 'gmail-callback',
        loadComponent: () => import('./auth/gmail-callback/gmail-callback.component')
          .then(m => m.GmailCallbackComponent)
      }
    ]
  },
  {
    path: 'setup',
    canActivate: [AuthGuard],
    loadComponent: () => import('./features/setup/setup.component')
      .then(m => m.SetupComponent)
  },
  {
    path: 'dashboard',
    canActivate: [AuthGuard],
    loadComponent: () => import('./features/dashboard/dashboard.component')
      .then(m => m.DashboardComponent)
  },
  {
    path: 'application/:id',
    canActivate: [AuthGuard],
    loadComponent: () => import('./features/application-edit/application-edit.component')
      .then(m => m.ApplicationEditComponent)
  },

  {
    path: 'admin',
    loadComponent: () => import('./features/admin/admin-dashboard/admin-dashboard.component').then(m => m.AdminDashboardComponent),
    canActivate: [AuthGuard]
  },
  {
  path: 'resumes',
  loadComponent: () => import('./features/resumes/resume-manager/resume-manager.component').then(m => m.ResumeManagerComponent),
  canActivate: [AuthGuard]
},
{
  path: 'candidates',
  loadComponent: () => import('./features/candidates/candidates/candidates.component').then(m => m.CandidatesComponent),
  canActivate: [AuthGuard]
},
{
  path: 'job-feed',
  loadComponent: () => import('./features/job-feed/job-feed/job-feed.component').then(m => m.JobFeedComponent),
  canActivate: [AuthGuard]
},
{
  path: 'interviews',
  loadComponent: () => import('./features/interviews/interview-calendar.component').then(m => m.InterviewCalendarComponent),
  canActivate: [AuthGuard]
},
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];