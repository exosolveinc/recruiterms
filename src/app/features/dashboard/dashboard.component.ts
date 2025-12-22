import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Profile, Resume, UserApplicationView } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  profile: Profile | null = null;

  // Stats
  stats = {
    applied: 0,
    interviews: 0,
    offers: 0,
    interviewRate: 0
  };

  // Resumes
  resumes: Resume[] = [];
  selectedResumeId = '';
  uploadingResume = false;

  // Job Extractor
  platform = 'LinkedIn';
  jobUrl = '';
  jobDescription = '';
  extracting = false;
  extractError = '';

  // Resume Modal
  showResumeModal = false;
  selectedResumeForView: Resume | null = null;
  resumeCache: Map<string, Resume> = new Map();

  // Match Analysis Modal
  showMatchModal = false;
  matchResult: {
    score: number;
    matching: string[];
    missing: string[];
    suggestions: string[];
  } | null = null;
  pendingJob: Partial<Job> | null = null;

  // Applications
  applications: UserApplicationView[] = [];
  searchTerm = '';
  loading = true;

  constructor(
    private supabase: SupabaseService,
    private router: Router
  ) { }

  async ngOnInit() {
    await this.loadProfile();
    await this.loadResumes();
    await this.loadApplications();
    this.calculateStats();
    this.loading = false;
  }

  async loadProfile() {
    const profile = await this.supabase.getProfile();
    if (!profile?.organization_id) {
      this.router.navigate(['/setup']);
      return;
    }
    this.profile = profile;
  }

  async loadResumes() {
    try {
      this.resumes = await this.supabase.getResumes();
      const primary = this.resumes.find(r => r.is_primary);
      if (primary) {
        this.selectedResumeId = primary.id;
      } else if (this.resumes.length > 0) {
        this.selectedResumeId = this.resumes[0].id;
      }
    } catch (err) {
      console.error('Failed to load resumes:', err);
    }
  }

  async loadApplications() {
    try {
      this.applications = await this.supabase.getApplicationsWithDetails();
    } catch (err) {
      console.error('Failed to load applications:', err);
      this.applications = [];
    }
  }

  calculateStats() {
    this.stats.applied = this.applications.length;
    this.stats.interviews = this.applications.filter(a =>
      ['interviewing', 'screening', 'offer', 'accepted'].includes(a.status)
    ).length;
    this.stats.offers = this.applications.filter(a =>
      ['offer', 'accepted'].includes(a.status)
    ).length;
    this.stats.interviewRate = this.stats.applied > 0
      ? Math.round((this.stats.interviews / this.stats.applied) * 100)
      : 0;
  }

  get filteredApplications(): UserApplicationView[] {
    if (!this.searchTerm) return this.applications;
    const term = this.searchTerm.toLowerCase();
    return this.applications.filter(app =>
      app.company_name?.toLowerCase().includes(term) ||
      app.job_title?.toLowerCase().includes(term)
    );
  }

  get selectedResume(): Resume | null {
    return this.resumes.find(r => r.id === this.selectedResumeId) || null;
  }

  // ============================================================================
  // RESUME UPLOAD (AI-powered)
  // ============================================================================

  async onResumeFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];

    // Get file extension
    const extension = file.name.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['pdf', 'docx'];

    if (!extension || !allowedExtensions.includes(extension)) {
      alert('Please upload a PDF or DOCX file. Old .doc format is not supported.');
      return;
    }

    this.uploadingResume = true;

    try {
      // Step 1: Upload file to storage
      console.log('Uploading file to storage...');
      const { url } = await this.supabase.uploadResumeFile(file);
      console.log('File uploaded:', url);

      // Step 2: Create resume record with processing status
      const resume = await this.supabase.createResume({
        file_name: file.name,
        file_url: url,
        file_type: file.type,
        extraction_status: 'processing'
      });

      // Step 3: Extract data using AI
      let extractedData: Partial<Resume>;

      try {
        console.log('Calling AI to extract resume...');
        extractedData = await this.supabase.extractResumeFromUrl(url, file.name);
        console.log('AI Resume Extraction Result:', extractedData);
        extractedData.extraction_status = 'completed';
      } catch (aiError: any) {
        console.error('AI resume extraction failed:', aiError);
        alert('AI extraction failed: ' + aiError.message);
        extractedData = {
          extraction_status: 'failed',
          extraction_confidence: 0
        };
      }

      // Step 4: Update resume with extracted data
      const updatedResume = await this.supabase.updateResume(resume.id, extractedData);

      // Step 5: Update UI
      this.resumes.unshift(updatedResume);
      this.selectedResumeId = updatedResume.id;

      console.log('Resume uploaded and processed:', updatedResume);

    } catch (err: any) {
      console.error('Resume upload error:', err);
      alert('Failed to upload resume: ' + err.message);
    } finally {
      this.uploadingResume = false;
      input.value = '';
    }
  }

  // ============================================================================
  // JOB EXTRACTION & APPLICATION (AI-powered)
  // ============================================================================

  async extractAndSave() {
    if (!this.selectedResumeId) {
      this.extractError = 'Please select or upload a resume first';
      return;
    }

    if (!this.jobDescription && !this.jobUrl) {
      this.extractError = 'Please paste a job description or enter a job URL';
      return;
    }

    this.extracting = true;
    this.extractError = '';

    try {
      // Step 1: Extract job data using AI
      console.log('Extracting job with AI...');
      let jobData: Partial<Job>;

      try {
        jobData = await this.supabase.extractJobWithAI(
          this.jobDescription,
          this.jobUrl,
          this.platform
        );
        console.log('AI Job Extraction Result:', jobData);
      } catch (aiError: any) {
        console.error('AI extraction failed:', aiError);
        this.extractError = 'AI extraction failed: ' + (aiError.message || 'Unknown error');
        this.extracting = false;
        return;
      }

      // Step 2: Get selected resume
      const resume = this.selectedResume;

      // Step 3: Analyze match using AI
      let matchResult: { score: number; matching: string[]; missing: string[]; suggestions: string[] };

      if (resume) {
        try {
          console.log('Analyzing match with AI...');
          const aiMatch = await this.supabase.analyzeMatchWithAI(resume, jobData);
          console.log('AI Match Result:', aiMatch);
          matchResult = {
            score: aiMatch.match_score,
            matching: aiMatch.matching_skills || [],
            missing: aiMatch.missing_skills || [],
            suggestions: aiMatch.recommendations || []
          };
        } catch (matchError: any) {
          console.error('AI match analysis failed, using local fallback:', matchError);
          matchResult = this.analyzeMatchLocally(resume, jobData);
        }
      } else {
        matchResult = { score: 70, matching: [], missing: [], suggestions: ['Select a resume for accurate matching'] };
      }

      // Store match data in job
      jobData.match_score = matchResult.score;
      jobData.matching_skills = matchResult.matching;
      jobData.missing_skills = matchResult.missing;
      jobData.recommendations = matchResult.suggestions;

      // Step 4: Check if low match - show modal
      if (matchResult.score < 50) {
        this.matchResult = matchResult;
        this.pendingJob = jobData;
        this.showMatchModal = true;
        this.extracting = false;
        return;
      }

      // Step 5: Save application
      await this.saveApplication(jobData, matchResult.score);

    } catch (err: any) {
      console.error('Extract and save error:', err);
      this.extractError = err.message || 'Failed to extract job data';
    } finally {
      this.extracting = false;
    }
  }

  // Local fallback for match analysis (if AI fails)
  private analyzeMatchLocally(resume: Resume, job: Partial<Job>): {
    score: number;
    matching: string[];
    missing: string[];
    suggestions: string[]
  } {
    if (!resume?.skills || !job.required_skills) {
      return {
        score: 70,
        matching: [],
        missing: [],
        suggestions: ['Upload a resume with skills to get accurate matching']
      };
    }

    const resumeSkills = resume.skills.map(s => s.name.toLowerCase());
    const jobSkills = job.required_skills.map(s => s.skill.toLowerCase());

    const matching = jobSkills.filter(skill =>
      resumeSkills.some(rs => rs.includes(skill) || skill.includes(rs))
    );
    const missing = jobSkills.filter(skill =>
      !resumeSkills.some(rs => rs.includes(skill) || skill.includes(rs))
    );

    const score = jobSkills.length > 0
      ? Math.round((matching.length / jobSkills.length) * 100)
      : 70;

    const suggestions: string[] = [];
    if (missing.length > 0) {
      suggestions.push(`Consider highlighting ${missing.slice(0, 3).join(', ')} if you have experience`);
    }
    if (score < 60) {
      suggestions.push('This role may require skills outside your current experience');
    }

    return { score, matching, missing, suggestions };
  }

  async saveApplication(jobData: Partial<Job>, matchScore: number) {
    try {
      let job: Job | undefined;

      // Check for existing job with same URL
      if (this.jobUrl) {
        const existingJobs = await this.supabase.getJobs();
        job = existingJobs.find(j => j.source_url === this.jobUrl);
      }

      // Create new job if not found
      if (!job) {
        job = await this.supabase.createJob({
          ...jobData,
          source_url: this.jobUrl || `manual-${Date.now()}`,
          platform: this.platform,
          match_score: matchScore,
          extraction_status: 'completed',
          status: 'applied'
        });
      }

      // Create application
      await this.supabase.createApplication({
        job_id: job.id,
        resume_id: this.selectedResumeId,
        status: 'applied',
        application_method: 'Direct'
      });

      // Refresh data
      await this.loadApplications();
      this.calculateStats();

      // Clear form
      this.jobUrl = '';
      this.jobDescription = '';
      this.showMatchModal = false;
      this.matchResult = null;
      this.pendingJob = null;

    } catch (err: any) {
      throw new Error(err.message || 'Failed to save application');
    }
  }

  async continueWithLowMatch() {
    if (this.pendingJob && this.matchResult) {
      this.extracting = true;
      try {
        await this.saveApplication(this.pendingJob, this.matchResult.score);
      } catch (err: any) {
        this.extractError = err.message;
      } finally {
        this.extracting = false;
      }
    }
  }

  cancelApplication() {
    this.showMatchModal = false;
    this.matchResult = null;
    this.pendingJob = null;
  }

  // ============================================================================
  // TABLE HELPERS
  // ============================================================================

  hasMoreSkills(app: UserApplicationView): boolean {
    return (app.required_skills?.length || 0) > 3;
  }

  getMoreSkillsCount(app: UserApplicationView): number {
    return Math.max(0, (app.required_skills?.length || 0) - 3);
  }

  getMatchClass(score: number | null): string {
    if (!score) return '';
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }

  canProgress(app: UserApplicationView): boolean {
    return ['applied', 'screening', 'interviewing'].includes(app.status);
  }

  progressApplication(app: UserApplicationView) {
    const nextStatus: Record<string, string> = {
      'applied': 'screening',
      'screening': 'interviewing',
      'interviewing': 'offer'
    };
    const next = nextStatus[app.status];
    if (next) {
      this.updateStatus(app, next);
    }
  }

  getSkills(app: UserApplicationView): string[] {
    if (!app.required_skills) return [];
    return app.required_skills.slice(0, 3).map(s =>
      typeof s === 'string' ? s : s.skill
    );
  }

  // ============================================================================
  // STATUS UPDATE & DELETE
  // ============================================================================

  async updateStatus(app: UserApplicationView, newStatus: string) {
    try {
      await this.supabase.updateApplication(app.id, { status: newStatus as any });
      app.status = newStatus as any;
      this.calculateStats();
    } catch (err: any) {
      alert('Failed to update status: ' + err.message);
    }
  }

  async deleteApplication(app: UserApplicationView) {
    if (!confirm(`Remove ${app.job_title} at ${app.company_name}?`)) return;

    try {
      await this.supabase.deleteApplication(app.id);
      this.applications = this.applications.filter(a => a.id !== app.id);
      this.calculateStats();
    } catch (err: any) {
      alert('Failed to delete: ' + err.message);
    }
  }

  // ============================================================================
  // RESUME VIEWING
  // ============================================================================

  getResumeForApp(app: UserApplicationView): Resume | null {
    if (!app.resume_id) return null;

    if (this.resumeCache.has(app.resume_id)) {
      return this.resumeCache.get(app.resume_id) || null;
    }

    const resume = this.resumes.find(r => r.id === app.resume_id);
    if (resume) {
      this.resumeCache.set(app.resume_id, resume);
      return resume;
    }

    this.loadResumeForApp(app.resume_id);
    return null;
  }

  private async loadResumeForApp(resumeId: string) {
    if (this.resumeCache.has(resumeId)) return;

    try {
      const resume = await this.supabase.getResume(resumeId);
      if (resume) {
        this.resumeCache.set(resumeId, resume);
      }
    } catch (err) {
      console.error('Failed to load resume:', err);
    }
  }

  viewResume(resume: Resume) {
    // Option 1: Open modal (current behavior)
    this.selectedResumeForView = resume;
    this.showResumeModal = true;
  }

  // Helper to get truncated resume name
  getResumeName(resume: Resume): string {
    const name = resume.candidate_name || resume.file_name || 'Resume';
    return name.length > 12 ? name.slice(0, 12) + '...' : name;
  }

  // Open resume file in new tab
  openResumeFile(resume: Resume) {
    if (resume.file_url) {
      window.open(resume.file_url, '_blank');
    } else {
      alert('Resume file not available');
    }
  }

  closeResumeModal() {
    this.showResumeModal = false;
    this.selectedResumeForView = null;
  }

  downloadResume(resume: Resume) {
    if (!resume.file_url) {
      alert('Resume file not available');
      return;
    }

    const link = document.createElement('a');
    link.href = resume.file_url;
    link.target = '_blank';
    link.download = resume.file_name || 'resume';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  goToResumes() {
    this.router.navigate(['/resumes']);
  }

  goToAnalyzer() {
    this.router.navigate(['/analyzer']);
  }

  // Delete selected resume
  async deleteSelectedResume() {
    if (!this.selectedResumeId) return;

    const resume = this.resumes.find(r => r.id === this.selectedResumeId);
    if (!resume) return;

    const confirmMsg = `Delete resume "${resume.candidate_name || resume.file_name}"?\n\nThis will also remove it from any applications.`;

    if (!confirm(confirmMsg)) return;

    try {
      // Delete from database
      await this.supabase.deleteResume(this.selectedResumeId);

      // Remove from local array
      this.resumes = this.resumes.filter(r => r.id !== this.selectedResumeId);

      // Select another resume or clear selection
      if (this.resumes.length > 0) {
        this.selectedResumeId = this.resumes[0].id;
      } else {
        this.selectedResumeId = '';
      }

      console.log('Resume deleted successfully');
    } catch (err: any) {
      alert('Failed to delete resume: ' + err.message);
    }
  }

  // ============================================================================
  // LOGOUT
  // ============================================================================

  async logout() {
    await this.supabase.signOut();
    this.router.navigate(['/auth/login']);
  }

  // ============================================================================
  // FORMAT HELPERS
  // ============================================================================

  formatSalary(min: number | null, max: number | null): string {
    if (!min && !max) return '';
    const format = (n: number) => `$${Math.round(n / 1000)}k`;
    if (min && max) return `${format(min)} - ${format(max)}`;
    if (min) return `${format(min)}+`;
    return `Up to ${format(max!)}`;
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}