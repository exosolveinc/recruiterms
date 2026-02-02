import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Job, Resume, UserApplicationView } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';
import { InterviewService, ScheduledInterview } from '../../core/services/interview.service';
import { AppStateService } from '../../core/services/app-state.service';
import { VendorEmailService } from '../../core/services/vendor-email.service';
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
  // Inject services
  private appState = inject(AppStateService);
  private vendorEmailService = inject(VendorEmailService);

  // Use signals from AppStateService
  readonly profile = this.appState.profile;
  readonly candidates = this.appState.candidates;
  readonly resumes = this.appState.resumes;
  readonly applications = this.appState.applications;
  readonly selectedCandidate = this.appState.selectedCandidate;
  readonly selectedResume = this.appState.selectedResume;
  readonly candidateResumes = this.appState.candidateResumes;
  readonly candidateStats = this.appState.candidateStats;
  readonly selectedCandidateId = this.appState.selectedCandidateId;
  readonly selectedResumeId = this.appState.selectedResumeId;

  // Email signals from AppStateService
  readonly candidateGmailStatus = this.appState.candidateGmailStatus;
  readonly candidateGmailAccounts = this.appState.candidateGmailAccounts;
  readonly candidateEmailStats = this.appState.candidateEmailStats;
  readonly candidateVendorJobs = this.appState.candidateVendorJobs;
  readonly candidateEmailsLoading = this.appState.candidateEmailsLoading;
  readonly candidateEmailsSyncing = this.appState.candidateEmailsSyncing;
  readonly candidateGmailConnected = this.appState.candidateGmailConnected;
  readonly candidateGmailCount = this.appState.candidateGmailCount;
  readonly canAddMoreGmail = this.appState.canAddMoreGmail;

  // Effect to load email data when candidate changes
  private candidateEmailEffect = effect(() => {
    const candidateId = this.selectedCandidateId();
    if (candidateId) {
      this.loadCandidateEmailData(candidateId);
    }
  });

  // Computed filtered applications with search
  readonly filteredApplications = computed(() => {
    let filtered = this.appState.filteredApplications();

    // Apply search filter
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      filtered = filtered.filter(app =>
        app.company_name?.toLowerCase().includes(term) ||
        app.job_title?.toLowerCase().includes(term)
      );
    }

    return filtered;
  });

  // Local state that doesn't need to be shared
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

  // Search term (local state)
  searchTerm = '';
  loading = true;

  // Expandable row
  expandedAppId: string | null = null;

  // Candidate Selection Drawer
  showCandidateDrawer = false;

  // Reanalysis state
  reanalyzingAppId: string | null = null;

  // Detailed match analysis per application
  detailedAnalysis: Map<string, {
    experienceMatch?: { score: number; details: string };
    educationMatch?: { score: number; details: string };
    requirementsFulfilled?: { percentage: number; met: string[]; notMet: string[] };
    resumeImprovements?: Array<{
      section: string;
      action: string;
      what_to_add: string;
      reason: string;
    }>;
    skillGaps?: Array<{
      skill: string;
      importance: string;
      suggestion: string;
      can_highlight_alternative?: string;
    }>;
    strengths?: string[];
    concerns?: string[];
    interviewTips?: string[];
    overallAssessment?: string;
    quickWins?: string[];
  }> = new Map();

  // Interview scheduling
  showInterviewModal = false;
  selectedAppForInterview: UserApplicationView | null = null;
  upcomingInterviews: ScheduledInterview[] = [];

  // Resume dropdown
  openResumeDropdownId: string | null = null;
  openDropdownSections: Set<string> = new Set();

  // Inline suggestions cache (per app)
  appSuggestionsCache: Map<string, string[]> = new Map();
  loadingSuggestionsForApp: string | null = null;

  // Job details cache (for expanded rows)
  jobDetailsCache: Map<string, Job> = new Map();
  loadingJobDetailsFor: string | null = null;

  // Interviews for expanded application
  expandedAppInterviews: ScheduledInterview[] = [];
  loadingAppInterviews = false;

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
    this.appState.setProfile(profile);
  }

  async loadCandidates() {
    if (this.appState.candidatesLoaded()) return; // Skip if already loaded

    try {
      this.appState.setCandidatesLoading(true);
      const candidates = await this.supabase.getCandidates();
      this.appState.setCandidates(candidates);
    } catch (err) {
      console.error('Failed to load candidates:', err);
    }
  }

  async loadApplications() {
    if (this.appState.applicationsLoaded()) return; // Skip if already loaded

    try {
      this.appState.setApplicationsLoading(true);
      const applications = await this.supabase.getApplicationsWithDetails();
      this.appState.setApplications(applications);
    } catch (err) {
      console.error('Failed to load applications:', err);
      this.appState.setApplications([]);
    }
  }

  calculateStats() {
    // Stats are now computed automatically via candidateStats signal
    // This method is kept for backward compatibility but does nothing
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

      // Step 5: Invalidate and reload candidates to refresh the UI
      this.appState.invalidateCandidates();
      await this.loadCandidates();

      // Select the newly uploaded resume
      this.appState.selectResume(updatedResume.id);


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
    if (!this.selectedResumeId()) {
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
      const resume = this.selectedResume();
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
        resume_id: this.selectedResumeId(),
        status: 'extracted',
        application_method: 'Direct'
      });

      // Refresh data - invalidate and reload
      this.appState.invalidateApplications();
      await this.loadApplications();

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
    if (this.expandedAppId === appId) {
      this.expandedAppId = null;
      this.expandedAppInterviews = [];
    } else {
      this.expandedAppId = appId;
      // Load job details when expanding
      const app = this.applications().find(a => a.id === appId);
      if (app) {
        this.loadJobDetailsIfNeeded(app);
        this.loadInterviewsForApp(appId);
      }
    }
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
      this.appState.removeApplication(app.id);
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

    const resume = this.resumes().find(r => r.id === app.resume_id);
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
    const resumeId = this.selectedResumeId();
    if (!resumeId) return;

    const resume = this.resumes().find(r => r.id === resumeId);
    if (!resume) return;

    const confirmMsg = `Delete resume "${resume.candidate_name || resume.file_name}"?\n\nThis will also remove it from any applications.`;

    if (!confirm(confirmMsg)) return;

    try {
      // Delete from database
      await this.supabase.deleteResume(resumeId);

      // Remove from state - this will also update candidates and handle selection
      this.appState.removeResume(resumeId);

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

  formatAppliedDate(dateStr: string | null): string {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const now = new Date();
    const diffTime = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  openJobUrl(url: string): void {
    if (url && !url.startsWith('manual')) {
      window.open(url, '_blank');
    }
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

  selectCandidate(candidateId: string) {
    this.appState.selectCandidate(candidateId);
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
    this.appState.selectResume(resumeId);
  }

  getAvgMatch(): number {
    const appsWithMatch = this.applications().filter(a => a.match_score);
    if (appsWithMatch.length === 0) return 0;
    const total = appsWithMatch.reduce((sum, a) => sum + (a.match_score || 0), 0);
    return Math.round(total / appsWithMatch.length);
  }

  // Get applications for selected candidate - uses computed signal
  getCandidateApplications(): number {
    return this.candidateStats().applied;
  }

  // Get interviews for selected candidate - uses computed signal
  getCandidateInterviews(): number {
    return this.candidateStats().interviews;
  }

  // Get average match for selected candidate - uses computed signal
  getCandidateAvgMatch(): number {
    return this.candidateStats().avgMatch;
  }

  // ============================================================================
  // CANDIDATE EMAIL METHODS
  // ============================================================================

  /**
   * Load email data for a candidate (Gmail accounts, stats, vendor jobs)
   */
  async loadCandidateEmailData(candidateId: string) {
    // Clear previous email state
    this.appState.clearCandidateEmailState();
    this.appState.setCandidateEmailsLoading(true);

    try {
      // Load Gmail connection status and all accounts for this candidate
      const [gmailStatus, gmailAccounts] = await Promise.all([
        this.vendorEmailService.getCandidateGmailStatus(candidateId),
        this.vendorEmailService.getCandidateGmailAccounts(candidateId)
      ]);

      this.appState.setCandidateGmailStatus(gmailStatus);
      this.appState.setCandidateGmailAccounts(gmailAccounts);

      // If connected, load email stats and vendor jobs
      if (gmailStatus.connected) {
        const [emailStats, vendorJobs] = await Promise.all([
          this.vendorEmailService.getCandidateEmailStats(candidateId),
          this.vendorEmailService.getCandidateVendorJobs(candidateId, { limit: 20 })
        ]);

        this.appState.setCandidateEmailStats(emailStats);
        this.appState.setCandidateVendorJobs(vendorJobs);
      }
    } catch (err) {
      console.error('Failed to load candidate email data:', err);
    } finally {
      this.appState.setCandidateEmailsLoading(false);
    }
  }

  /**
   * Connect Gmail for the selected candidate
   */
  async connectCandidateGmail() {
    const candidateId = this.selectedCandidateId();
    if (!candidateId) {
      alert('Please select a candidate first');
      return;
    }

    // Check if candidate can add more Gmail accounts (max 3)
    if (!this.canAddMoreGmail()) {
      alert('Maximum of 3 Gmail accounts per candidate. Please disconnect one to add another.');
      return;
    }

    try {
      // Get OAuth URL with candidateId
      const { authUrl } = await this.vendorEmailService.getGmailAuthUrl(candidateId);

      // Store candidateId in sessionStorage for callback
      sessionStorage.setItem('gmail_oauth_candidate_id', candidateId);

      // Redirect to Google OAuth
      window.location.href = authUrl;
    } catch (err: any) {
      console.error('Failed to start Gmail OAuth:', err);
      alert('Failed to connect Gmail: ' + err.message);
    }
  }

  /**
   * Disconnect a specific Gmail account by connection ID
   */
  async disconnectGmailAccount(connectionId: string, email: string) {
    if (!confirm(`Disconnect ${email}? Synced jobs will be kept.`)) return;

    try {
      const success = await this.vendorEmailService.disconnectGmailConnection(connectionId);
      if (success) {
        // Remove from local state
        this.appState.removeCandidateGmailAccount(connectionId);

        // Reload email data if no more accounts
        const candidateId = this.selectedCandidateId();
        if (candidateId) {
          await this.loadCandidateEmailData(candidateId);
        }
      }
    } catch (err: any) {
      console.error('Failed to disconnect Gmail:', err);
      alert('Failed to disconnect: ' + err.message);
    }
  }

  /**
   * Disconnect Gmail for the selected candidate (legacy - disconnects all)
   */
  async disconnectCandidateGmail() {
    const candidateId = this.selectedCandidateId();
    if (!candidateId) return;

    if (!confirm('Disconnect Gmail for this candidate? Synced jobs will be kept.')) return;

    try {
      await this.vendorEmailService.disconnectCandidateGmail(candidateId);
      this.appState.clearCandidateEmailState();
    } catch (err: any) {
      console.error('Failed to disconnect Gmail:', err);
      alert('Failed to disconnect: ' + err.message);
    }
  }

  /**
   * Sync emails for a specific Gmail connection
   */
  async syncGmailAccount(connectionId: string) {
    this.appState.setCandidateEmailsSyncing(true);

    try {
      const result = await this.vendorEmailService.syncGmailConnection(connectionId);

      // Reload email data after sync
      const candidateId = this.selectedCandidateId();
      if (candidateId) {
        await this.loadCandidateEmailData(candidateId);
      }

      if (result.jobsCreated > 0) {
        console.log(`Synced ${result.emailsParsed} emails, found ${result.jobsCreated} new jobs`);
      }
    } catch (err: any) {
      console.error('Failed to sync emails:', err);
      alert('Failed to sync emails: ' + err.message);
    } finally {
      this.appState.setCandidateEmailsSyncing(false);
    }
  }

  /**
   * Sync emails for the selected candidate (all accounts)
   */
  async syncCandidateEmails() {
    const candidateId = this.selectedCandidateId();
    if (!candidateId) return;

    this.appState.setCandidateEmailsSyncing(true);

    try {
      const result = await this.vendorEmailService.syncCandidateEmails(candidateId);

      // Reload email data after sync
      await this.loadCandidateEmailData(candidateId);

      // Show result
      if (result.jobsCreated > 0) {
        console.log(`Synced ${result.emailsParsed} emails, found ${result.jobsCreated} new jobs`);
      }
    } catch (err: any) {
      console.error('Failed to sync emails:', err);
      alert('Failed to sync emails: ' + err.message);
    } finally {
      this.appState.setCandidateEmailsSyncing(false);
    }
  }

  /**
   * Get new job opportunities count for display
   */
  getCandidateNewJobs(): number {
    return this.candidateEmailStats()?.new_jobs ?? 0;
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
    const resume = this.resumes().find(r => r.id === app.resume_id);
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
      this.appState.invalidateCandidates();
      this.appState.invalidateApplications();
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
    // Reload interviews for the expanded app if it matches
    if (this.expandedAppId && interview.application_id === this.expandedAppId) {
      await this.loadInterviewsForApp(this.expandedAppId);
    }
    this.appState.invalidateApplications();
    await this.loadApplications();
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

  async loadInterviewsForApp(appId: string) {
    this.loadingAppInterviews = true;
    this.expandedAppInterviews = [];
    try {
      this.expandedAppInterviews = await this.interviewService.getInterviewsForApplication(appId);
    } catch (err) {
      console.error('Failed to load interviews for app:', err);
    } finally {
      this.loadingAppInterviews = false;
    }
  }

  getUpcomingInterviewsForExpanded(): ScheduledInterview[] {
    const now = new Date();
    return this.expandedAppInterviews.filter(i => new Date(i.scheduled_at) >= now);
  }

  getPastInterviewsForExpanded(): ScheduledInterview[] {
    const now = new Date();
    return this.expandedAppInterviews.filter(i => new Date(i.scheduled_at) < now);
  }

  getInterviewStatusClass(interview: ScheduledInterview): string {
    const statusClasses: Record<string, string> = {
      'scheduled': 'status-scheduled',
      'completed': 'status-completed',
      'cancelled': 'status-cancelled',
      'pending': 'status-pending'
    };
    return statusClasses[interview.status] || 'status-pending';
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

      // Store detailed analysis in component state
      this.detailedAnalysis.set(app.id, {
        experienceMatch: aiMatch.experience_match,
        educationMatch: aiMatch.education_match,
        requirementsFulfilled: aiMatch.requirements_fulfilled ? {
          percentage: aiMatch.requirements_fulfilled.percentage,
          met: aiMatch.requirements_fulfilled.met || [],
          notMet: aiMatch.requirements_fulfilled.not_met || []
        } : undefined,
        resumeImprovements: aiMatch.resume_improvements || [],
        skillGaps: aiMatch.skill_gaps || [],
        strengths: aiMatch.strengths || [],
        concerns: aiMatch.concerns || [],
        interviewTips: aiMatch.interview_tips || [],
        overallAssessment: aiMatch.overall_assessment,
        quickWins: aiMatch.quick_wins || []
      });

      // Reload applications to reflect new data
      this.appState.invalidateApplications();
      await this.loadApplications();

      // Keep the row expanded
      this.expandedAppId = app.id;

    } catch (err: any) {
      console.error('Re-analysis failed:', err);
      alert('Failed to re-analyze: ' + (err.message || 'Unknown error'));
    }
  }

  // Helper to get detailed analysis for an application
  getDetailedAnalysis(appId: string) {
    return this.detailedAnalysis.get(appId);
  }

  // Helper to check if detailed analysis exists
  hasDetailedAnalysis(appId: string): boolean {
    return this.detailedAnalysis.has(appId);
  }

  // ============================================================================
  // RESUME DROPDOWN ACTIONS
  // ============================================================================

  toggleResumeDropdown(appId: string, event: Event) {
    event.stopPropagation();
    if (this.openResumeDropdownId === appId) {
      this.openResumeDropdownId = null;
      this.openDropdownSections.clear();
    } else {
      this.openResumeDropdownId = appId;
      this.openDropdownSections.clear();
      // Auto-expand resume section by default
      this.openDropdownSections.add('resume-' + appId);
    }
  }

  closeResumeDropdown() {
    this.openResumeDropdownId = null;
    this.openDropdownSections.clear();
  }

  toggleDropdownSection(sectionId: string) {
    if (this.openDropdownSections.has(sectionId)) {
      this.openDropdownSections.delete(sectionId);
    } else {
      this.openDropdownSections.add(sectionId);
    }
  }

  isDropdownSectionOpen(sectionId: string): boolean {
    return this.openDropdownSections.has(sectionId);
  }

  // Load analysis when section is opened (if not already loaded)
  loadAnalysisIfNeeded(app: UserApplicationView) {
    if (!app.match_score && !app.matching_skills?.length && app.resume_id) {
      // Trigger analysis if not already done
      if (this.reanalyzingAppId !== app.id) {
        this.reanalyzeApplication(app);
      }
    }
  }

  // Load suggestions when section is opened
  async loadSuggestionsIfNeeded(app: UserApplicationView) {
    // Check if already cached
    if (this.appSuggestionsCache.has(app.id)) {
      return;
    }

    if (!app.resume_id) {
      this.appSuggestionsCache.set(app.id, ['No resume attached. Please upload a resume first.']);
      return;
    }

    const resume = this.getResumeForApp(app);
    if (!resume) {
      this.appSuggestionsCache.set(app.id, ['Could not load resume.']);
      return;
    }

    this.loadingSuggestionsForApp = app.id;

    try {
      const job = await this.supabase.getJob(app.job_id);
      if (!job) {
        throw new Error('Could not find job details');
      }

      // Check if we already have detailed analysis
      const existingAnalysis = this.getDetailedAnalysis(app.id);
      let suggestions: string[] = [];

      if (existingAnalysis?.resumeImprovements?.length) {
        suggestions = existingAnalysis.resumeImprovements.map(
          imp => `${imp.section}: ${imp.what_to_add}`
        );
      } else {
        // Run analysis to get suggestions
        const aiMatch = await this.supabase.analyzeMatchWithAI(resume, job);

        // Store the analysis
        this.detailedAnalysis.set(app.id, {
          experienceMatch: aiMatch.experience_match,
          educationMatch: aiMatch.education_match,
          requirementsFulfilled: aiMatch.requirements_fulfilled ? {
            percentage: aiMatch.requirements_fulfilled.percentage,
            met: aiMatch.requirements_fulfilled.met || [],
            notMet: aiMatch.requirements_fulfilled.not_met || []
          } : undefined,
          resumeImprovements: aiMatch.resume_improvements || [],
          skillGaps: aiMatch.skill_gaps || [],
          strengths: aiMatch.strengths || [],
          concerns: aiMatch.concerns || [],
          interviewTips: aiMatch.interview_tips || [],
          overallAssessment: aiMatch.overall_assessment,
          quickWins: aiMatch.quick_wins || []
        });

        if (aiMatch.resume_improvements?.length) {
          suggestions = aiMatch.resume_improvements.map(
            (imp: any) => `${imp.section}: ${imp.what_to_add}`
          );
        } else if (aiMatch.quick_wins?.length) {
          suggestions = aiMatch.quick_wins;
        } else if (app.missing_skills?.length) {
          suggestions = app.missing_skills.slice(0, 5).map(
            skill => `Add experience demonstrating ${skill}`
          );
        } else {
          suggestions = ['Your resume appears well-matched to this role.'];
        }
      }

      this.appSuggestionsCache.set(app.id, suggestions);
    } catch (err: any) {
      console.error('Failed to get suggestions:', err);
      this.appSuggestionsCache.set(app.id, ['Failed to generate suggestions.']);
    } finally {
      this.loadingSuggestionsForApp = null;
    }
  }

  getAppSuggestions(appId: string): string[] {
    return this.appSuggestionsCache.get(appId) || [];
  }

  // ============================================================================
  // JOB DETAILS FOR EXPANDED ROW
  // ============================================================================

  async loadJobDetailsIfNeeded(app: UserApplicationView) {
    // Check if already cached
    if (this.jobDetailsCache.has(app.job_id)) {
      return;
    }

    this.loadingJobDetailsFor = app.id;

    try {
      const job = await this.supabase.getJob(app.job_id);
      if (job) {
        this.jobDetailsCache.set(app.job_id, job);
      }
    } catch (err) {
      console.error('Failed to load job details:', err);
    } finally {
      this.loadingJobDetailsFor = null;
    }
  }

  getJobDetails(jobId: string): Job | null {
    return this.jobDetailsCache.get(jobId) || null;
  }

  getJobDescription(jobId: string): string | null {
    const job = this.jobDetailsCache.get(jobId);
    if (!job) return null;
    return job.description_full || job.description_summary || null;
  }

  getJobResponsibilities(jobId: string): string[] {
    const job = this.jobDetailsCache.get(jobId);
    return job?.responsibilities || [];
  }

  getJobQualifications(jobId: string): string[] {
    const job = this.jobDetailsCache.get(jobId);
    return job?.qualifications || [];
  }

  goToAdminDashboard() {
    this.router.navigate(['/admin']);
  }
}