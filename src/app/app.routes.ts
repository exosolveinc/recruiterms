import { Routes } from '@angular/router';
import { AuthGuard, GuestGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'dashboard',
    pathMatch: 'full'
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
    path: 'admin',
    loadComponent: () => import('./features/admin/admin-dashboard/admin-dashboard.component').then(m => m.AdminDashboardComponent),
    canActivate: [AuthGuard]
  },
  {
  path: 'resumes',
  loadComponent: () => import('./features/resumes/resume-manager/resume-manager.component').then(m => m.ResumeManagerComponent),
  canActivate: [AuthGuard]
},
// {
//   path: 'analyzer',
//   loadComponent: () => import('./features/analyzer/job-analyzer/job-analyzer.component').then(m => m.JobAnalyzerComponent),
//   canActivate: [AuthGuard]
// },
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];