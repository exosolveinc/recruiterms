import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClientModule } from '@angular/common/http';
import { Profile } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { JobFeedService, ExternalJob, JobSearchParams } from '../../../core/services/job-feed.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, SidebarComponent],
  templateUrl: './job-feed.component.html',
  styleUrl: './job-feed.component.scss'
})
export class JobFeedComponent implements OnInit {
  profile: Profile | null = null;
  jobs: ExternalJob[] = [];
  loading = false;
  searching = false;

  // Search params
  searchQuery = '';
  searchLocation = '';
  selectedSource: 'all' | 'adzuna' | 'rapidapi' = 'adzuna';

  // Pagination
  currentPage = 1;
  totalJobs = 0;
  totalPages = 0;
  resultsPerPage = 20;

  // Selected job for preview
  selectedJob: ExternalJob | null = null;

  // Stats
  stats = {
    totalFound: 0,
    averageSalary: 0
  };

  // Popular searches
  popularSearches = [
    'Software Engineer',
    'Data Scientist',
    'Product Manager',
    'UX Designer',
    'DevOps Engineer',
    'Frontend Developer',
    'Backend Developer',
    'Full Stack Developer'
  ];

  constructor(
    private supabase: SupabaseService,
    private jobFeedService: JobFeedService,
    private router: Router
  ) {}

  async ngOnInit() {
    await this.loadProfile();
  }

  async loadProfile() {
    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.profile = profile;
  }

  async searchJobs() {
    if (!this.searchQuery.trim()) return;

    this.searching = true;
    this.currentPage = 1;

    const params: JobSearchParams = {
      query: this.searchQuery,
      location: this.searchLocation || undefined,
      page: this.currentPage,
      resultsPerPage: this.resultsPerPage
    };

    try {
      let result;
      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else {
        result = await this.jobFeedService.searchAllJobs(params);
      }

      this.jobs = result.jobs;
      this.totalJobs = result.total;
      this.totalPages = result.totalPages;
      this.calculateStats();
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  async loadMore() {
    if (this.currentPage >= this.totalPages || this.loading) return;

    this.loading = true;
    this.currentPage++;

    const params: JobSearchParams = {
      query: this.searchQuery,
      location: this.searchLocation || undefined,
      page: this.currentPage,
      resultsPerPage: this.resultsPerPage
    };

    try {
      let result;
      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else {
        result = await this.jobFeedService.searchAllJobs(params);
      }

      this.jobs = [...this.jobs, ...result.jobs];
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      this.loading = false;
    }
  }

  quickSearch(query: string) {
    this.searchQuery = query;
    this.searchJobs();
  }

  calculateStats() {
    this.stats.totalFound = this.totalJobs;

    const jobsWithSalary = this.jobs.filter(j => j.salary_min || j.salary_max);
    if (jobsWithSalary.length > 0) {
      const totalSalary = jobsWithSalary.reduce((sum, j) => {
        const avg = ((j.salary_min || 0) + (j.salary_max || j.salary_min || 0)) / 2;
        return sum + avg;
      }, 0);
      this.stats.averageSalary = Math.round(totalSalary / jobsWithSalary.length);
    } else {
      this.stats.averageSalary = 0;
    }
  }

  selectJob(job: ExternalJob) {
    this.selectedJob = job;
  }

  closeJobPreview() {
    this.selectedJob = null;
  }

  applyToJob(job: ExternalJob) {
    if (job.url) {
      window.open(job.url, '_blank');
    }
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  truncateDescription(text: string, maxLength: number = 200): string {
    if (!text) return '';
    // Strip HTML tags
    const stripped = text.replace(/<[^>]*>/g, '');
    if (stripped.length <= maxLength) return stripped;
    return stripped.substring(0, maxLength) + '...';
  }

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  goToResumes() {
    this.router.navigate(['/resumes']);
  }

  goToCandidates() {
    this.router.navigate(['/candidates']);
  }

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }
}
