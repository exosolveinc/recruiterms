import { Injectable } from '@angular/core';
import { CanActivate, CanActivateChild, Router } from '@angular/router';
import { Observable, from } from 'rxjs';
import { filter, map, switchMap, take, tap } from 'rxjs/operators';
import { SupabaseService } from '../services/supabase.service';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate, CanActivateChild {
  
  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    // Wait for initialization to complete before checking session
    return this.supabase.initialized$.pipe(
      filter(initialized => initialized),
      take(1),
      switchMap(() => this.supabase.session$),
      take(1),
      map(session => !!session),
      tap(isAuthenticated => {
        if (!isAuthenticated) {
          this.router.navigate(['/auth/login']);
        }
      })
    );
  }

  canActivateChild(): Observable<boolean> {
    return this.canActivate();
  }
}

@Injectable({
  providedIn: 'root'
})
export class AdminGuard implements CanActivate {

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    // Wait for initialization to complete before checking profile
    return this.supabase.initialized$.pipe(
      filter(initialized => initialized),
      take(1),
      switchMap(() => this.supabase.profile$),
      take(1),
      map(profile => profile?.role === 'admin'),
      tap(isAdmin => {
        if (!isAdmin) {
          this.router.navigate(['/dashboard']);
        }
      })
    );
  }
}

@Injectable({
  providedIn: 'root'
})
export class GuestGuard implements CanActivate {
  
  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    // Wait for initialization to complete before checking session
    return this.supabase.initialized$.pipe(
      filter(initialized => initialized),
      take(1),
      switchMap(() => this.supabase.session$),
      take(1),
      switchMap(session => {
        if (!session) {
          // Not logged in - allow access to guest pages
          return from(Promise.resolve(true));
        }

        // Logged in - redirect to appropriate dashboard
        return from(this.redirectLoggedInUser());
      })
    );
  }

  private async redirectLoggedInUser(): Promise<boolean> {
    try {
      const profile = await this.supabase.getProfile();
      
      if (!profile?.organization_id) {
        this.router.navigate(['/setup']);
      } else if (profile.role === 'admin') {
        this.router.navigate(['/admin']);
      } else {
        this.router.navigate(['/dashboard']);
      }
    } catch (err) {
      this.router.navigate(['/dashboard']);
    }
    
    return false; // Block access to guest page
  }
}

@Injectable({
  providedIn: 'root'
})
export class SetupGuard implements CanActivate {

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    // Wait for initialization to complete before checking session
    return this.supabase.initialized$.pipe(
      filter(initialized => initialized),
      take(1),
      switchMap(() => this.supabase.session$),
      take(1),
      switchMap(session => {
        if (!session) {
          this.router.navigate(['/auth/login']);
          return from(Promise.resolve(false));
        }
        return from(this.checkSetupNeeded());
      })
    );
  }

  private async checkSetupNeeded(): Promise<boolean> {
    try {
      const profile = await this.supabase.getProfile();
      
      if (profile?.organization_id) {
        // Already has org - redirect to appropriate dashboard
        if (profile.role === 'admin') {
          this.router.navigate(['/admin']);
        } else {
          this.router.navigate(['/dashboard']);
        }
        return false;
      }
      
      return true; // Allow access to setup
    } catch (err) {
      return true;
    }
  }
}