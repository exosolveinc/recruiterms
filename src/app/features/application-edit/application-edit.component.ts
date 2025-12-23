import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { UserApplicationView, Resume } from '../../core/models';
import { SupabaseService } from '../../core/services/supabase.service';

@Component({
  selector: 'app-application-edit',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './application-edit.component.html',
  styleUrls: ['./application-edit.component.scss']
})
export class ApplicationEditComponent implements OnInit {
  applicationId: string = '';
  application: UserApplicationView | null = null;
  resume: Resume | null = null;
  allResumes: Resume[] = [];
  loading = true;
  saving = false;
  error = '';
  uploadingResume = false;
  analyzing = false;
  matchResult: {
    score: number;
    matching: string[];
    missing: string[];
    suggestions: string[];
  } | null = null;

  // Form fields - initialized from application data
  jobTitle = '';
  companyName = '';
  platform = '';
  workType = '';
  location = '';
  salaryMin: number | null = null;
  salaryMax: number | null = null;
  experienceLevel = '';
  status = '';
  appliedAt = '';
  nextStep = '';
  nextStepDate = '';
  offeredSalary: number | null = null;
  outcome = '';
  notes = '';

  // Skills management
  requiredSkills: Array<{skill: string, importance?: string, years?: number}> = [];
  newSkill = '';
  newSkillImportance = 'required';
  newSkillYears: number | null = null;

  // Interviews management
  interviews: Array<{
    type?: string;
    scheduled_at?: string;
    duration_minutes?: number;
    location?: string;
    interviewer?: string;
    notes?: string;
    outcome?: string;
  }> = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private supabase: SupabaseService
  ) {}

  async ngOnInit() {
    this.applicationId = this.route.snapshot.paramMap.get('id') || '';

    if (!this.applicationId) {
      this.error = 'No application ID provided';
      this.loading = false;
      return;
    }

    await this.loadApplication();
  }

  async loadApplication() {
    try {
      this.loading = true;
      const applications = await this.supabase.getApplicationsWithDetails();
      this.application = applications.find(app => app.id === this.applicationId) || null;

      if (!this.application) {
        this.error = 'Application not found';
        this.loading = false;
        return;
      }

      // Load all resumes for the selector
      try {
        this.allResumes = await this.supabase.getResumes();
      } catch (err) {
        console.error('Failed to load resumes:', err);
      }

      // Load resume if available
      if (this.application.resume_id) {
        try {
          this.resume = await this.supabase.getResume(this.application.resume_id);
        } catch (err) {
          console.error('Failed to load resume:', err);
        }
      }

      // Populate form fields
      this.populateForm();
      this.loading = false;
    } catch (err: any) {
      console.error('Failed to load application:', err);
      this.error = err.message || 'Failed to load application';
      this.loading = false;
    }
  }

  populateForm() {
    if (!this.application) return;

    this.jobTitle = this.application.job_title || '';
    this.companyName = this.application.company_name || '';
    this.platform = this.application.platform || '';
    this.workType = this.application.work_type || '';
    this.location = this.application.location || '';
    this.salaryMin = this.application.salary_min;
    this.salaryMax = this.application.salary_max;
    this.experienceLevel = this.application.experience_level || '';
    this.status = this.application.status;
    this.appliedAt = this.application.applied_at ? this.formatDateForInput(this.application.applied_at) : '';
    this.nextStep = this.application.next_step || '';
    this.nextStepDate = this.application.next_step_date ? this.formatDateForInput(this.application.next_step_date) : '';
    this.offeredSalary = this.application.offered_salary;
    this.outcome = this.application.outcome || '';
    this.notes = this.application.notes || '';

    // Handle skills
    if (this.application.required_skills) {
      this.requiredSkills = [...this.application.required_skills];
    }

    // Handle interviews
    if (this.application.interviews) {
      this.interviews = [...this.application.interviews];
    }
  }

  formatDateForInput(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  }

  // Skills Management
  addSkill() {
    if (!this.newSkill.trim()) return;

    this.requiredSkills.push({
      skill: this.newSkill.trim(),
      importance: this.newSkillImportance,
      years: this.newSkillYears || undefined
    });

    // Reset form
    this.newSkill = '';
    this.newSkillImportance = 'required';
    this.newSkillYears = null;
  }

  removeSkill(index: number) {
    this.requiredSkills.splice(index, 1);
  }

  // Interviews Management
  addInterview() {
    this.interviews.push({
      type: 'phone',
      scheduled_at: '',
      duration_minutes: 60,
      location: '',
      interviewer: '',
      notes: '',
      outcome: ''
    });
  }

  removeInterview(index: number) {
    this.interviews.splice(index, 1);
  }

  async saveChanges() {
    if (!this.application) return;

    this.saving = true;
    this.error = '';

    try {
      // Update application
      await this.supabase.updateApplication(this.application.id, {
        status: this.status as any,
        next_step: this.nextStep || null,
        next_step_date: this.nextStepDate || null,
        offered_salary: this.offeredSalary,
        outcome: this.outcome || null,
        notes: this.notes || null,
        interviews: this.interviews as any
      });

      // Update job details - we'll need to update the job record
      // Note: This requires knowing the job_id from the application
      if (this.application.job_id) {
        await this.supabase.updateJob(this.application.job_id, {
          job_title: this.jobTitle,
          company_name: this.companyName,
          platform: this.platform,
          work_type: this.workType as any,
          location: this.location,
          salary_min: this.salaryMin,
          salary_max: this.salaryMax,
          experience_level: this.experienceLevel,
          required_skills: this.requiredSkills as any
        });
      }

      // Navigate back to dashboard
      this.router.navigate(['/dashboard']);
    } catch (err: any) {
      console.error('Failed to save application:', err);
      this.error = err.message || 'Failed to save changes';
      this.saving = false;
    }
  }

  cancel() {
    this.router.navigate(['/dashboard']);
  }

  getResumeName(): string {
    if (!this.resume) return 'No resume';
    return this.resume.candidate_name || this.resume.file_name || 'Resume';
  }

  downloadResume() {
    if (!this.resume?.file_url) {
      alert('Resume file not available');
      return;
    }

    const link = document.createElement('a');
    link.href = this.resume.file_url;
    link.target = '_blank';
    link.download = this.resume.file_name || 'resume';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return 'Not set';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  // Resume Management
  async onResumeFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    const extension = file.name.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['pdf', 'docx'];

    if (!extension || !allowedExtensions.includes(extension)) {
      alert('Please upload a PDF or DOCX file.');
      return;
    }

    this.uploadingResume = true;

    try {
      // Upload file to storage
      const { url } = await this.supabase.uploadResumeFile(file);

      // Create resume record
      const resume = await this.supabase.createResume({
        file_name: file.name,
        file_url: url,
        file_type: file.type,
        extraction_status: 'processing'
      });

      // Extract data using AI
      let extractedData: Partial<Resume>;
      try {
        extractedData = await this.supabase.extractResumeFromUrl(url, file.name);
        extractedData.extraction_status = 'completed';
      } catch (aiError) {
        console.error('AI resume extraction failed:', aiError);
        extractedData = {
          extraction_status: 'failed',
          extraction_confidence: 0
        };
      }

      // Update resume with extracted data
      const updatedResume = await this.supabase.updateResume(resume.id, extractedData);

      // Update application with new resume
      if (this.application) {
        await this.supabase.updateApplication(this.application.id, {
          resume_id: updatedResume.id
        });
        this.application.resume_id = updatedResume.id;
        this.resume = updatedResume;
      }

      // Refresh resumes list
      this.allResumes.unshift(updatedResume);

      alert('Resume uploaded successfully!');
    } catch (err: any) {
      console.error('Resume upload error:', err);
      alert('Failed to upload resume: ' + err.message);
    } finally {
      this.uploadingResume = false;
      input.value = '';
    }
  }

  async changeResume(resumeId: string) {
    if (!this.application) return;

    try {
      await this.supabase.updateApplication(this.application.id, {
        resume_id: resumeId
      });
      this.application.resume_id = resumeId;
      this.resume = this.allResumes.find(r => r.id === resumeId) || null;

      // Clear match result since resume changed
      this.matchResult = null;
    } catch (err: any) {
      alert('Failed to change resume: ' + err.message);
    }
  }

  async deleteCurrentResume() {
    if (!this.resume) return;

    const confirmMsg = `Delete resume "${this.resume.candidate_name || this.resume.file_name}"?\n\nThis will remove it from this application.`;
    if (!confirm(confirmMsg)) return;

    try {
      await this.supabase.deleteResume(this.resume.id);

      // Update application to remove resume reference
      if (this.application) {
        await this.supabase.updateApplication(this.application.id, {
          resume_id: null
        });
        this.application.resume_id = null;
      }

      this.resume = null;
      this.allResumes = this.allResumes.filter(r => r.id !== this.resume?.id);
      this.matchResult = null;
    } catch (err: any) {
      alert('Failed to delete resume: ' + err.message);
    }
  }

  // AI Analysis
  async runAnalyzer() {
    if (!this.resume || !this.application) {
      alert('Please select a resume first');
      return;
    }

    this.analyzing = true;

    try {
      // Build job data from current form fields
      const jobData: Partial<any> = {
        job_title: this.jobTitle,
        company_name: this.companyName,
        required_skills: this.requiredSkills.map(s => ({
          skill: s.skill,
          importance: (s.importance === 'required' ? 'Required' : 'Preferred') as 'Required' | 'Preferred',
          years: s.years
        })),
        experience_level: this.experienceLevel,
        location: this.location,
        work_type: this.workType,
        salary_min: this.salaryMin,
        salary_max: this.salaryMax
      };

      // Analyze match using AI
      const aiMatch = await this.supabase.analyzeMatchWithAI(this.resume, jobData);

      this.matchResult = {
        score: aiMatch.match_score,
        matching: aiMatch.matching_skills || [],
        missing: aiMatch.missing_skills || [],
        suggestions: aiMatch.recommendations || []
      };

      // Update application with match score
      if (this.application.job_id) {
        await this.supabase.updateJob(this.application.job_id, {
          match_score: aiMatch.match_score,
          matching_skills: aiMatch.matching_skills,
          missing_skills: aiMatch.missing_skills,
          recommendations: aiMatch.recommendations
        });
      }
    } catch (err: any) {
      console.error('AI analysis failed:', err);
      alert('Failed to analyze match: ' + err.message);
    } finally {
      this.analyzing = false;
    }
  }

  getMatchClass(score: number): string {
    if (score >= 80) return 'match-high';
    if (score >= 60) return 'match-medium';
    return 'match-low';
  }
}
