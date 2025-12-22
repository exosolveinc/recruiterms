import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Job } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';

@Component({
  selector: 'app-job-list',
  standalone: true,
  imports: [CommonModule, RouterLink, FormsModule],
  templateUrl: './job-list.component.html',
  styleUrls: ['./job-list.component.scss']
})
export class JobListComponent implements OnInit {
  jobs: Job[] = [];
  filteredJobs: Job[] = [];
  loading = true;
  error = '';
  
  // Filters
  searchTerm = '';
  statusFilter = 'all';
  platformFilter = 'all';

  // Available filter options
  platforms: string[] = [];

  constructor(private supabase: SupabaseService) {}

  async ngOnInit() {
    await this.loadJobs();
  }

  async loadJobs() {
    try {
      this.loading = true;
      this.jobs = await this.supabase.getJobs();
      this.filteredJobs = this.jobs;
      
      // Extract unique platforms
      // Extract unique platforms
this.platforms = [...new Set(this.jobs.map(j => j.platform).filter((p): p is string => !!p))];
    } catch (err: any) {
      this.error = err.message || 'Failed to load jobs';
    } finally {
      this.loading = false;
    }
  }

  applyFilters() {
    this.filteredJobs = this.jobs.filter(job => {
      // Search filter
      const matchesSearch = !this.searchTerm || 
        job.job_title?.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        job.company_name?.toLowerCase().includes(this.searchTerm.toLowerCase());

      // Status filter
      const matchesStatus = this.statusFilter === 'all' || job.status === this.statusFilter;

      // Platform filter
      const matchesPlatform = this.platformFilter === 'all' || job.platform === this.platformFilter;

      return matchesSearch && matchesStatus && matchesPlatform;
    });
  }

  async deleteJob(job: Job, event: Event) {
    event.stopPropagation();
    
    if (!confirm(`Delete "${job.job_title}" from ${job.company_name}?`)) {
      return;
    }

    try {
      await this.supabase.deleteJob(job.id);
      this.jobs = this.jobs.filter(j => j.id !== job.id);
      this.applyFilters();
    } catch (err: any) {
      alert('Failed to delete job: ' + err.message);
    }
  }

  getStatusClass(status: string): string {
    const classes: Record<string, string> = {
      'new': 'status-new',
      'reviewing': 'status-reviewing',
      'applied': 'status-applied',
      'interviewing': 'status-interviewing',
      'offered': 'status-offered',
      'rejected': 'status-rejected',
      'archived': 'status-archived'
    };
    return classes[status] || 'status-new';
  }

  formatSalary(job: Job): string {
    if (!job.salary_min && !job.salary_max) return '—';
    
    const currency = job.salary_currency || 'USD';
    const min = job.salary_min ? `${currency} ${job.salary_min.toLocaleString()}` : '';
    const max = job.salary_max ? `${currency} ${job.salary_max.toLocaleString()}` : '';
    
    if (min && max) return `${min} - ${max}`;
    return min || max;
  }
}