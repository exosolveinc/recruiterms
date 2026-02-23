import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { SupabaseService } from '../../../core/services/supabase.service';

export interface AdminDashboardData {
  applications: any[];
  upcomingInterviews: any[];
  lastUpdated: Date;
}

@Injectable({ providedIn: 'root' })
export class AdminDashboardService {
  private cache$ = new BehaviorSubject<AdminDashboardData | null>(null);

  constructor(private supabase: SupabaseService) {}

  get cached(): AdminDashboardData | null {
    return this.cache$.value;
  }

  async loadData(forceRefresh = false): Promise<AdminDashboardData> {
    if (!forceRefresh && this.cache$.value) {
      return this.cache$.value;
    }

    const applications = await this.supabase.getAdminApplications();

    let upcomingInterviews: any[] = [];
    try {
      upcomingInterviews = await this.supabase.getAdminUpcomingInterviews();
    } catch {
      upcomingInterviews = [];
    }

    const data: AdminDashboardData = {
      applications,
      upcomingInterviews,
      lastUpdated: new Date()
    };

    this.cache$.next(data);
    return data;
  }

  clearCache() {
    this.cache$.next(null);
  }
}