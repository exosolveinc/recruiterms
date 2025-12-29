import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClientModule } from '@angular/common/http';
import { Candidate, Profile, Resume } from '../../../core/models';
import { SupabaseService } from '../../../core/services/supabase.service';
import { JobFeedService, ExternalJob, JobSearchParams, JobPlatform } from '../../../core/services/job-feed.service';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';

interface JobWithMatch extends ExternalJob {
  match_score?: number;
  matching_skills?: string[];
  missing_skills?: string[];
  analyzing?: boolean;
  analyzed?: boolean;
}

@Component({
  selector: 'app-job-feed',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, SidebarComponent],
  templateUrl: './job-feed.component.html',
  styleUrl: './job-feed.component.scss'
})
export class JobFeedComponent implements OnInit {
  profile: Profile | null = null;
  jobs: JobWithMatch[] = [];
  loading = false;
  searching = false;

  // Candidates & Resumes
  candidates: Candidate[] = [];
  selectedCandidateId = '';
  selectedResumeId = '';
  showCandidateDrawer = false;
  candidateSearchQuery = '';

  // Search params
  searchQuery = '';
  searchLocation = '';
  selectedSource: JobPlatform = 'adzuna';

  // Available job platforms
  jobPlatforms: { value: JobPlatform; label: string; isAI?: boolean }[] = [
    { value: 'adzuna', label: 'Adzuna' },
    { value: 'rapidapi', label: 'JSearch (RapidAPI)' },
    { value: 'dice', label: 'Dice (AI)', isAI: true },
    { value: 'linkedin', label: 'LinkedIn (AI)', isAI: true },
    { value: 'indeed', label: 'Indeed (AI)', isAI: true },
    { value: 'glassdoor', label: 'Glassdoor (AI)', isAI: true },
    { value: 'ai-search', label: 'AI Search (All Platforms)', isAI: true },
    { value: 'all', label: 'All Sources' }
  ];

  // AI search platforms to include
  aiSearchPlatforms = ['dice', 'indeed', 'linkedin', 'glassdoor'];

  // Preference-based search
  usePreferences = true;

  // Pagination
  currentPage = 1;
  totalJobs = 0;
  totalPages = 0;
  resultsPerPage = 20;

  // Selected job for preview
  selectedJob: JobWithMatch | null = null;

  // Analyzing state
  analyzingAll = false;
  analyzedCount = 0;

  // Stats
  stats = {
    totalFound: 0,
    averageSalary: 0,
    avgMatchScore: 0
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
    await this.loadCandidates();
  }

  async loadProfile() {
    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.profile = profile;
  }

  async loadCandidates() {
    try {
      this.candidates = await this.supabase.getCandidates();
      // Auto-select first candidate if available
      if (this.candidates.length > 0) {
        this.selectCandidate(this.candidates[0].id);
      }
    } catch (err) {
      console.error('Failed to load candidates:', err);
    }
  }

  get selectedCandidate(): Candidate | null {
    return this.candidates.find(c => c.id === this.selectedCandidateId) || null;
  }

  get selectedResume(): Resume | null {
    const candidate = this.selectedCandidate;
    if (!candidate) return null;
    return candidate.resumes.find(r => r.id === this.selectedResumeId) || null;
  }

  get candidateResumes(): Resume[] {
    return this.selectedCandidate?.resumes || [];
  }

  get filteredCandidates(): Candidate[] {
    if (!this.candidateSearchQuery.trim()) {
      return this.candidates;
    }
    const query = this.candidateSearchQuery.toLowerCase();
    return this.candidates.filter(c =>
      c.name.toLowerCase().includes(query) ||
      (c.current_title && c.current_title.toLowerCase().includes(query))
    );
  }

  openCandidateDrawer() {
    this.showCandidateDrawer = true;
    this.candidateSearchQuery = '';
  }

  closeCandidateDrawer() {
    this.showCandidateDrawer = false;
  }

  selectCandidateFromDrawer(candidateId: string) {
    this.selectCandidate(candidateId);
  }

  selectCandidate(candidateId: string) {
    this.selectedCandidateId = candidateId;
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this.selectedResumeId = primary?.id || candidate.resumes[0].id;
    } else {
      this.selectedResumeId = '';
    }
    // Reset match scores when candidate changes
    this.jobs.forEach(job => {
      job.match_score = undefined;
      job.matching_skills = undefined;
      job.missing_skills = undefined;
      job.analyzed = false;
    });

    // Auto-fill search fields from preferences if enabled
    if (this.usePreferences && candidate) {
      this.fillSearchFromPreferences(candidate);
    }
  }

  // Fill search fields from candidate preferences
  fillSearchFromPreferences(candidate: Candidate) {
    // Fill job title from preferred titles or current title
    if (candidate.preferences?.preferred_job_titles?.length) {
      this.searchQuery = candidate.preferences.preferred_job_titles[0];
    } else if (candidate.current_title) {
      this.searchQuery = candidate.current_title;
    }

    // Fill location from preferred locations or candidate location
    if (candidate.preferences?.preferred_locations?.length) {
      this.searchLocation = candidate.preferences.preferred_locations[0];
    } else if (candidate.location) {
      this.searchLocation = candidate.location;
    }
  }

  // Search using all preferred job titles
  async searchWithPreferences() {
    const candidate = this.selectedCandidate;
    if (!candidate) return;

    // Get all preferred job titles or fall back to current title
    const titles = candidate.preferences?.preferred_job_titles?.length
      ? candidate.preferences.preferred_job_titles
      : candidate.current_title
        ? [candidate.current_title]
        : [];

    if (titles.length === 0) {
      // No preferences, just do a regular search
      this.searchJobs();
      return;
    }

    // Get location - use "Remote" if remote is preferred and no specific location
    const preferredWorkTypes = candidate.preferences?.preferred_work_type || [];
    const prefersRemote = preferredWorkTypes.includes('remote');

    let location = '';
    if (candidate.preferences?.preferred_locations?.length) {
      location = candidate.preferences.preferred_locations[0];
    } else if (prefersRemote) {
      location = 'Remote';
    } else if (candidate.location) {
      location = candidate.location;
    }

    this.searchLocation = location;
    this.searching = true;
    this.currentPage = 1;
    this.jobs = [];

    try {
      // Search for each preferred job title and combine results
      const allJobs: JobWithMatch[] = [];
      const seenIds = new Set<string>();

      for (const title of titles.slice(0, 3)) { // Limit to first 3 titles
        // Add "remote" to query if that's their preference
        const searchTitle = prefersRemote && !title.toLowerCase().includes('remote')
          ? `${title} remote`
          : title;

        this.searchQuery = title;

        const params: JobSearchParams = {
          query: searchTitle,
          location: location || undefined,
          page: 1,
          resultsPerPage: 10 // Get 10 per title
        };

        let result;
        if (this.selectedSource === 'adzuna') {
          result = await this.jobFeedService.searchAdzunaJobs(params);
        } else if (this.selectedSource === 'rapidapi') {
          result = await this.jobFeedService.searchRapidApiJobs(params);
        } else {
          result = await this.jobFeedService.searchAllJobs(params);
        }

        // Add unique jobs
        for (const job of result.jobs) {
          if (!seenIds.has(job.id)) {
            seenIds.add(job.id);
            allJobs.push({
              ...job,
              match_score: undefined,
              matching_skills: undefined,
              missing_skills: undefined,
              analyzing: false,
              analyzed: false
            });
          }
        }
      }

      this.jobs = allJobs;
      this.totalJobs = allJobs.length;
      this.totalPages = 1;
      this.searchQuery = titles.join(', '); // Show combined titles in search
      this.calculateStats();

      // Auto-analyze if resume is selected
      if (this.selectedResumeId && this.jobs.length > 0) {
        this.analyzeAllJobs();
      }
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  // Check if job matches candidate's work type preference
  checkWorkTypeMatch(job: JobWithMatch): { matches: boolean; reason: string } {
    const candidate = this.selectedCandidate;
    if (!candidate?.preferences?.preferred_work_type?.length) {
      return { matches: true, reason: '' };
    }

    const preferredTypes = candidate.preferences.preferred_work_type;
    const jobLocation = (job.location || '').toLowerCase();
    const jobType = (job.employment_type || '').toLowerCase();
    const jobDescription = (job.description || '').toLowerCase();

    // Check if job is remote
    const isRemote = jobLocation.includes('remote') ||
                     jobType.includes('remote') ||
                     jobDescription.includes('fully remote') ||
                     jobDescription.includes('100% remote');

    // Check if job is hybrid
    const isHybrid = jobLocation.includes('hybrid') ||
                     jobType.includes('hybrid') ||
                     jobDescription.includes('hybrid');

    // Check if job is onsite
    const isOnsite = !isRemote && !isHybrid;

    if (preferredTypes.includes('remote') && isRemote) {
      return { matches: true, reason: 'Remote position matches preference' };
    }
    if (preferredTypes.includes('hybrid') && isHybrid) {
      return { matches: true, reason: 'Hybrid position matches preference' };
    }
    if (preferredTypes.includes('onsite') && isOnsite) {
      return { matches: true, reason: 'Onsite position matches preference' };
    }

    // Check if any preferred type might match
    if (preferredTypes.includes('remote') && !isRemote) {
      return { matches: false, reason: 'Position may not be remote' };
    }

    return { matches: true, reason: '' };
  }

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
    // Reset match scores when resume changes
    this.jobs.forEach(job => {
      job.match_score = undefined;
      job.matching_skills = undefined;
      job.missing_skills = undefined;
      job.analyzed = false;
    });
  }

  // Build search query from candidate preferences
  getPreferenceBasedQuery(): { query: string; location: string } {
    const candidate = this.selectedCandidate;
    const resume = this.selectedResume;

    let query = this.searchQuery;
    let location = this.searchLocation;

    if (this.usePreferences && candidate) {
      // Use preferred job titles or current title
      if (!query && candidate.preferences?.preferred_job_titles?.length) {
        query = candidate.preferences.preferred_job_titles[0];
      } else if (!query && candidate.current_title) {
        query = candidate.current_title;
      }

      // Use preferred locations
      if (!location && candidate.preferences?.preferred_locations?.length) {
        location = candidate.preferences.preferred_locations[0];
      } else if (!location && candidate.location) {
        location = candidate.location;
      }
    }

    return { query, location };
  }

  async searchJobs() {
    const { query, location } = this.getPreferenceBasedQuery();
    if (!query.trim()) return;

    this.searchQuery = query;
    this.searchLocation = location;
    this.searching = true;
    this.currentPage = 1;

    const params: JobSearchParams = {
      query: query,
      location: location || undefined,
      page: this.currentPage,
      resultsPerPage: this.resultsPerPage,
      workType: this.selectedCandidate?.preferences?.preferred_work_type?.[0] as any
    };

    try {
      let result;

      // Determine which search method to use based on selected source
      if (this.selectedSource === 'adzuna') {
        result = await this.jobFeedService.searchAdzunaJobs(params);
      } else if (this.selectedSource === 'rapidapi') {
        result = await this.jobFeedService.searchRapidApiJobs(params);
      } else if (this.selectedSource === 'ai-search') {
        // AI search across all platforms
        result = await this.jobFeedService.searchWithAI(params, this.aiSearchPlatforms);
      } else if (['dice', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter'].includes(this.selectedSource)) {
        // AI search for specific platform
        result = await this.jobFeedService.searchWithAI(params, [this.selectedSource]);
      } else if (this.selectedSource === 'all') {
        // Search all sources including AI
        const [adzunaResult, aiResult] = await Promise.all([
          this.jobFeedService.searchAdzunaJobs(params),
          this.jobFeedService.searchWithAI(params, ['dice', 'indeed', 'linkedin'])
        ]);
        // Combine and deduplicate results
        const allJobs = [...adzunaResult.jobs, ...aiResult.jobs];
        const uniqueJobs = this.deduplicateJobs(allJobs);
        result = {
          jobs: uniqueJobs,
          total: adzunaResult.total + aiResult.total,
          page: 1,
          totalPages: 1
        };
      } else {
        result = await this.jobFeedService.searchAllJobs(params);
      }

      this.jobs = result.jobs.map(job => ({
        ...job,
        match_score: undefined,
        matching_skills: undefined,
        missing_skills: undefined,
        analyzing: false,
        analyzed: false
      }));
      this.totalJobs = result.total;
      this.totalPages = result.totalPages;
      this.calculateStats();

      // Auto-analyze if candidate is selected
      if (this.selectedResumeId && this.jobs.length > 0) {
        this.analyzeAllJobs();
      }
    } catch (err) {
      console.error('Search error:', err);
      this.jobs = [];
    } finally {
      this.searching = false;
    }
  }

  // Deduplicate jobs by title and company
  private deduplicateJobs(jobs: JobWithMatch[]): JobWithMatch[] {
    const seen = new Set<string>();
    return jobs.filter(job => {
      const key = `${job.title.toLowerCase()}-${job.company.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

      const newJobs = result.jobs.map(job => ({
        ...job,
        match_score: undefined,
        matching_skills: undefined,
        missing_skills: undefined,
        analyzing: false,
        analyzed: false
      }));
      this.jobs = [...this.jobs, ...newJobs];

      // Analyze new jobs
      if (this.selectedResumeId) {
        this.analyzeNewJobs(newJobs);
      }
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      this.loading = false;
    }
  }

  async analyzeAllJobs() {
    if (!this.selectedResume || this.jobs.length === 0) return;

    this.analyzingAll = true;
    this.analyzedCount = 0;

    // Analyze jobs in batches of 3 to avoid rate limiting
    const batchSize = 3;
    for (let i = 0; i < this.jobs.length; i += batchSize) {
      const batch = this.jobs.slice(i, i + batchSize);
      await Promise.all(batch.map(job => this.analyzeJob(job)));
      this.analyzedCount = Math.min(i + batchSize, this.jobs.length);
    }

    this.analyzingAll = false;
    this.calculateStats();
    this.sortJobsByMatch();
  }

  async analyzeNewJobs(jobs: JobWithMatch[]) {
    if (!this.selectedResume) return;

    const batchSize = 3;
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      await Promise.all(batch.map(job => this.analyzeJob(job)));
    }
    this.calculateStats();
  }

  async analyzeJob(job: JobWithMatch) {
    if (!this.selectedResume || job.analyzing || job.analyzed) return;

    job.analyzing = true;

    try {
      // Create a partial job object for analysis
      const jobData = {
        job_title: job.title,
        company_name: job.company,
        location: job.location,
        description_full: job.description,
        required_skills: this.extractSkillsFromDescription(job.description),
        employment_type: job.employment_type,
        salary_min: job.salary_min,
        salary_max: job.salary_max
      };

      const result = await this.supabase.analyzeMatchWithAI(this.selectedResume, jobData);

      job.match_score = result.match_score;
      job.matching_skills = result.matching_skills || [];
      job.missing_skills = result.missing_skills || [];
      job.analyzed = true;
    } catch (err) {
      console.error('Analysis error for job:', job.title, err);
      job.match_score = undefined;
    } finally {
      job.analyzing = false;
    }
  }

  // Simple skill extraction from job description
  extractSkillsFromDescription(description: string): { skill: string; importance: 'Required' | 'Preferred' }[] {
    const commonSkills = [
      'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP',
      'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'Spring', '.NET',
      'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'CI/CD', 'Git', 'Linux',
      'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch',
      'Machine Learning', 'AI', 'Data Science', 'TensorFlow', 'PyTorch',
      'Agile', 'Scrum', 'REST API', 'GraphQL', 'Microservices'
    ];

    const descLower = description.toLowerCase();
    const foundSkills: { skill: string; importance: 'Required' | 'Preferred' }[] = [];

    commonSkills.forEach(skill => {
      if (descLower.includes(skill.toLowerCase())) {
        foundSkills.push({ skill, importance: 'Required' });
      }
    });

    return foundSkills;
  }

  sortJobsByMatch() {
    this.jobs.sort((a, b) => {
      if (a.match_score === undefined && b.match_score === undefined) return 0;
      if (a.match_score === undefined) return 1;
      if (b.match_score === undefined) return -1;
      return b.match_score - a.match_score;
    });
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

    // Calculate average match score
    const jobsWithMatch = this.jobs.filter(j => j.match_score !== undefined);
    if (jobsWithMatch.length > 0) {
      const totalMatch = jobsWithMatch.reduce((sum, j) => sum + (j.match_score || 0), 0);
      this.stats.avgMatchScore = Math.round(totalMatch / jobsWithMatch.length);
    } else {
      this.stats.avgMatchScore = 0;
    }
  }

  selectJob(job: JobWithMatch) {
    this.selectedJob = job;
    // Analyze if not already analyzed
    if (!job.analyzed && this.selectedResumeId) {
      this.analyzeJob(job);
    }
  }

  closeJobPreview() {
    this.selectedJob = null;
  }

  applyToJob(job: ExternalJob) {
    if (job.url) {
      window.open(job.url, '_blank');
    }
  }

  async saveJob(job: JobWithMatch) {
    if (!this.selectedResumeId) {
      alert('Please select a candidate and resume first');
      return;
    }

    try {
      // Create job in database
      const jobData = {
        source_url: job.url,
        platform: job.source,
        job_title: job.title,
        company_name: job.company,
        location: job.location,
        description_full: job.description,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        employment_type: job.employment_type,
        match_score: job.match_score,
        matching_skills: job.matching_skills,
        missing_skills: job.missing_skills,
        status: 'new' as const,
        extraction_status: 'completed' as const
      };

      const savedJob = await this.supabase.createJob(jobData);

      // Create application
      await this.supabase.createApplication({
        job_id: savedJob.id,
        resume_id: this.selectedResumeId,
        status: 'extracted'
      });

      alert('Job saved to your applications!');
    } catch (err: any) {
      console.error('Save job error:', err);
      alert('Failed to save job: ' + err.message);
    }
  }

  getMatchClass(score: number | undefined): string {
    if (score === undefined) return '';
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }

  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  getResumeLabel(resume: Resume): string {
    if (resume.label) return resume.label;
    if (resume.file_name) {
      return resume.file_name.split('.')[0] || 'Resume';
    }
    return 'Resume';
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
