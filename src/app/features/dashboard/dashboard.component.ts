import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Candidate, Job, Profile, Resume, UserApplicationView } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';
import { InterviewService, ScheduledInterview } from '../../core/services/interview.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { InterviewModalComponent } from '../../shared/interview-modal/interview-modal.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, InterviewModalComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  profile: Profile | null = null;

  // Stats
  stats = {
    applied: 0,
    interviews: 0,
    interviewRate: 0
  };

  // Candidates & Resumes
  candidates: Candidate[] = [];
  selectedCandidateId = '';
  resumes: Resume[] = [];  // All resumes (for backward compat)
  selectedResumeId = '';
  uploadingResume = false;

  // Job Extractor
  platform = 'Auto-detect';
  jobUrl = '';
  jobDescription = '';
  extracting = false;
  extractError = '';

  // Loading animation state
  loadingSteps = [
    'Extracting job details...',
    'Analyzing your resume...',
    'Comparing skills...',
    'Generating recommendations...'
  ];
  currentLoadingStep = 0;
  completedSteps: number[] = [];

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

  // Expandable row
  expandedAppId: string | null = null;

  // Candidate Selection Drawer
  showCandidateDrawer = false;

  // Reanalysis state
  reanalyzingAppId: string | null = null;

  // Interview scheduling
  showInterviewModal = false;
  selectedAppForInterview: UserApplicationView | null = null;
  upcomingInterviews: ScheduledInterview[] = [];

  constructor(
    private supabase: SupabaseService,
    private router: Router,
    private interviewService: InterviewService
  ) { }

  async ngOnInit() {
    await this.loadProfile();
    await this.loadCandidates();
    await this.loadApplications();
    await this.loadUpcomingInterviews();
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

  async loadCandidates() {
    try {
      this.candidates = await this.supabase.getCandidates();
      // Also load all resumes for backward compat
      this.resumes = await this.supabase.getResumes();

      // Auto-select first candidate if available
      if (this.candidates.length > 0) {
        this.selectCandidate(this.candidates[0].id);
      }
    } catch (err) {
      console.error('Failed to load candidates:', err);
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
      const { url } = await this.supabase.uploadResumeFile(file);

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
        extractedData = await this.supabase.extractResumeFromUrl(url, file.name);
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

      // Step 5: Reload candidates to refresh the UI
      await this.loadCandidates();

      // Select the newly uploaded resume
      this.selectedResumeId = updatedResume.id;


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
      this.extractError = 'Please enter a job URL or paste the job description';
      return;
    }

    this.extracting = true;
    this.extractError = '';
    this.currentLoadingStep = 0;
    this.completedSteps = [];

    try {
      // Step 1: Extract job details
      this.currentLoadingStep = 0;
      console.log('Extracting job with AI...');
      let jobData: Partial<Job>;

      try {
        jobData = await this.supabase.extractJobWithAI(
          this.jobDescription,
          this.jobUrl,
          this.platform
        );
        console.log('AI Job Extraction Result:', jobData);
        this.completedSteps.push(0);
      } catch (aiError: any) {
        console.error('AI extraction failed:', aiError);
        this.extractError = 'AI extraction failed: ' + (aiError.message || 'Unknown error');
        this.extracting = false;
        return;
      }

      // Step 2: Analyzing resume
      this.currentLoadingStep = 1;
      await this.delay(300); // Brief pause for visual feedback
      const resume = this.selectedResume;
      this.completedSteps.push(1);

      // Step 3: Comparing skills
      this.currentLoadingStep = 2;
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
      this.completedSteps.push(2);

      // Step 4: Generating recommendations
      this.currentLoadingStep = 3;
      await this.delay(300); // Brief pause for visual feedback

      // Store match data in job
      jobData.match_score = matchResult.score;
      jobData.matching_skills = matchResult.matching;
      jobData.missing_skills = matchResult.missing;
      jobData.recommendations = matchResult.suggestions;
      this.completedSteps.push(3);

      // Check if low match - show modal
      if (matchResult.score < 50) {
        this.matchResult = matchResult;
        this.pendingJob = jobData;
        this.showMatchModal = true;
        this.extracting = false;
        return;
      }

      // Save application
      await this.saveApplication(jobData, matchResult.score);

    } catch (err: any) {
      console.error('Extract and save error:', err);
      this.extractError = err.message || 'Failed to extract job data';
    } finally {
      this.extracting = false;
      this.currentLoadingStep = 0;
      this.completedSteps = [];
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      const newApplication = await this.supabase.createApplication({
        job_id: job.id,
        resume_id: this.selectedResumeId,
        status: 'extracted',
        application_method: 'Direct'
      });

      // Refresh data
      await this.loadApplications();
      this.calculateStats();

      // Expand the newly created application row
      this.expandedAppId = newApplication.id;

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

  toggleExpand(appId: string, event: Event) {
    event.stopPropagation();
    this.expandedAppId = this.expandedAppId === appId ? null : appId;
  }

  isExpanded(appId: string): boolean {
    return this.expandedAppId === appId;
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

  // Candidate Drawer
  openCandidateDrawer() {
    this.showCandidateDrawer = true;
  }

  closeCandidateDrawer() {
    this.showCandidateDrawer = false;
  }

  selectCandidateAndClose(candidateId: string) {
    this.selectCandidate(candidateId);
    this.closeCandidateDrawer();
  }

  goToCandidates() {
    this.router.navigate(['/candidates']);
  }

  goToJobFeed() {
    this.router.navigate(['/job-feed']);
  }

  goToAnalyzer() {
    this.router.navigate(['/analyzer']);
  }

  editApplication(app: UserApplicationView) {
    this.router.navigate(['/application', app.id]);
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

  // Auto-detect platform from URL
  detectPlatformFromUrl(url: string): string {
    if (!url) return 'Auto-detect';
    const urlLower = url.toLowerCase();

    if (urlLower.includes('linkedin.com')) return 'LinkedIn';
    if (urlLower.includes('indeed.com')) return 'Indeed';
    if (urlLower.includes('glassdoor.com')) return 'Glassdoor';
    if (urlLower.includes('dice.com')) return 'Dice';
    if (urlLower.includes('ziprecruiter.com')) return 'ZipRecruiter';
    if (urlLower.includes('angel.co') || urlLower.includes('wellfound.com')) return 'AngelList';
    if (urlLower.includes('greenhouse.io')) return 'Greenhouse';
    if (urlLower.includes('lever.co')) return 'Lever';
    if (urlLower.includes('workday.com') || urlLower.includes('myworkdayjobs.com')) return 'Workday';
    if (urlLower.includes('ashbyhq.com')) return 'Ashby';
    if (urlLower.includes('jobs.') || urlLower.includes('/jobs') || urlLower.includes('/careers')) return 'Company Website';

    return 'Other';
  }

  onJobUrlChange(url: string) {
    this.jobUrl = url;
    const detected = this.detectPlatformFromUrl(url);
    if (detected !== 'Auto-detect') {
      this.platform = detected;
    }
  }

  // ============================================================================
  // CANDIDATE SELECTOR HELPERS
  // ============================================================================

  get selectedCandidate(): Candidate | null {
    return this.candidates.find(c => c.id === this.selectedCandidateId) || null;
  }

  get candidateResumes(): Resume[] {
    const candidate = this.selectedCandidate;
    if (!candidate) return [];
    return candidate.resumes || [];
  }

  selectCandidate(candidateId: string) {
    this.selectedCandidateId = candidateId;
    // Auto-select primary resume or first resume for this candidate
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (candidate && candidate.resumes.length > 0) {
      const primary = candidate.resumes.find(r => r.is_primary);
      this.selectedResumeId = primary?.id || candidate.resumes[0].id;
    } else {
      this.selectedResumeId = '';
    }
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

  selectResume(resumeId: string) {
    this.selectedResumeId = resumeId;
  }

  getAvgMatch(): number {
    const appsWithMatch = this.applications.filter(a => a.match_score);
    if (appsWithMatch.length === 0) return 0;
    const total = appsWithMatch.reduce((sum, a) => sum + (a.match_score || 0), 0);
    return Math.round(total / appsWithMatch.length);
  }

  // Get applications for selected candidate
  getCandidateApplications(): number {
    if (!this.selectedCandidateId) return 0;
    const candidateResumeIds = this.candidateResumes.map(r => r.id);
    return this.applications.filter(a => a.resume_id && candidateResumeIds.includes(a.resume_id)).length;
  }

  // Get interviews for selected candidate
  getCandidateInterviews(): number {
    if (!this.selectedCandidateId) return 0;
    const candidateResumeIds = this.candidateResumes.map(r => r.id);
    return this.applications.filter(a =>
      a.resume_id && candidateResumeIds.includes(a.resume_id) &&
      ['interviewing', 'screening', 'offer', 'accepted'].includes(a.status)
    ).length;
  }

  // Get average match for selected candidate
  getCandidateAvgMatch(): number {
    if (!this.selectedCandidateId) return 0;
    const candidateResumeIds = this.candidateResumes.map(r => r.id);
    const candidateApps = this.applications.filter(a =>
      a.resume_id && candidateResumeIds.includes(a.resume_id) && a.match_score
    );
    if (candidateApps.length === 0) return 0;
    const total = candidateApps.reduce((sum, a) => sum + (a.match_score || 0), 0);
    return Math.round(total / candidateApps.length);
  }

  getCompanyColor(companyName: string | null): string {
    const colors = [
      '#635BFF', // Stripe purple
      '#5E6AD2', // Linear purple
      '#96BF48', // Shopify green
      '#FF5A5F', // Airbnb red
      '#000000', // Vercel black
      '#A259FF', // Figma purple
      '#0A66C2', // LinkedIn blue
      '#E01E5A', // Slack pink
    ];
    if (!companyName) return colors[0];
    const hash = companyName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }

  getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      'extracted': 'Extracted',
      'applied': 'Applied',
      'screening': 'Screening',
      'interviewing': 'Interview',
      'offer': 'Offer',
      'accepted': 'Accepted',
      'rejected': 'Rejected',
      'withdrawn': 'Withdrawn'
    };
    return labels[status] || status;
  }

  getResumeNameForApp(app: UserApplicationView): string {
    if (!app.resume_id) return '—';
    const resume = this.resumes.find(r => r.id === app.resume_id);
    if (!resume) return '—';
    return this.getResumeLabel(resume);
  }

  // ============================================================================
  // REUPLOAD & REANALYZE
  // ============================================================================

  async onReuploadResume(event: Event, app: UserApplicationView) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    const extension = file.name.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['pdf', 'docx'];

    if (!extension || !allowedExtensions.includes(extension)) {
      alert('Please upload a PDF or DOCX file.');
      return;
    }

    this.reanalyzingAppId = app.id;

    try {
      // Step 1: Upload file to storage
      const { url } = await this.supabase.uploadResumeFile(file);

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
        extractedData = await this.supabase.extractResumeFromUrl(url, file.name);
        extractedData.extraction_status = 'completed';
      } catch (aiError: any) {
        console.error('AI resume extraction failed:', aiError);
        extractedData = {
          extraction_status: 'failed',
          extraction_confidence: 0
        };
      }

      // Step 4: Update resume with extracted data
      const updatedResume = await this.supabase.updateResume(resume.id, extractedData);

      // Step 5: Update the application to use this new resume
      await this.supabase.updateApplication(app.id, { resume_id: updatedResume.id });

      // Step 6: Reload data
      await this.loadCandidates();
      await this.loadApplications();

      // Step 7: Reanalyze the match with the new resume
      await this.reanalyzeApplicationWithResume(app, updatedResume);

    } catch (err: any) {
      console.error('Resume reupload error:', err);
      alert('Failed to upload resume: ' + err.message);
    } finally {
      this.reanalyzingAppId = null;
      input.value = '';
    }
  }

  // ============================================================================
  // INTERVIEW SCHEDULING
  // ============================================================================

  async loadUpcomingInterviews() {
    try {
      this.upcomingInterviews = await this.interviewService.getUpcomingInterviews(7);
    } catch (err) {
      console.error('Failed to load upcoming interviews:', err);
      this.upcomingInterviews = [];
    }
  }

  openInterviewModal(app: UserApplicationView) {
    this.selectedAppForInterview = app;
    this.showInterviewModal = true;
  }

  closeInterviewModal() {
    this.showInterviewModal = false;
    this.selectedAppForInterview = null;
  }

  async onInterviewScheduled(interview: ScheduledInterview) {
    this.closeInterviewModal();
    await this.loadUpcomingInterviews();
    await this.loadApplications();
    this.calculateStats();
  }

  getInterviewsForApp(app: UserApplicationView): ScheduledInterview[] {
    return this.upcomingInterviews.filter(i => i.application_id === app.id);
  }

  hasUpcomingInterview(app: UserApplicationView): boolean {
    return this.getInterviewsForApp(app).length > 0;
  }

  getNextInterviewDate(app: UserApplicationView): string {
    const interviews = this.getInterviewsForApp(app);
    if (interviews.length === 0) return '';
    const next = interviews[0];
    return this.formatInterviewDate(next.scheduled_at);
  }

  formatInterviewDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    } else if (diffDays === 1) {
      return `Tomorrow at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  }

  async reanalyzeApplication(app: UserApplicationView) {
    if (!app.resume_id) {
      alert('No resume attached. Please attach a resume first.');
      return;
    }

    const resume = this.getResumeForApp(app);
    if (!resume) {
      alert('Could not load resume. Please try again.');
      return;
    }

    this.reanalyzingAppId = app.id;

    try {
      await this.reanalyzeApplicationWithResume(app, resume);
    } finally {
      this.reanalyzingAppId = null;
    }
  }

  private async reanalyzeApplicationWithResume(app: UserApplicationView, resume: Resume) {
    try {
      // Get the job details
      const job = await this.supabase.getJob(app.job_id);
      if (!job) {
        throw new Error('Could not find job details');
      }

      // Analyze match using AI
      console.log('Re-analyzing match with AI...');
      const aiMatch = await this.supabase.analyzeMatchWithAI(resume, job);
      console.log('AI Re-analysis Result:', aiMatch);

      // Update the job with new match data
      await this.supabase.updateJob(job.id, {
        match_score: aiMatch.match_score,
        matching_skills: aiMatch.matching_skills || [],
        missing_skills: aiMatch.missing_skills || [],
        recommendations: aiMatch.recommendations || []
      });

      // Reload applications to reflect new data
      await this.loadApplications();

      // Keep the row expanded
      this.expandedAppId = app.id;

    } catch (err: any) {
      console.error('Re-analysis failed:', err);
      alert('Failed to re-analyze: ' + (err.message || 'Unknown error'));
    }
  }
}