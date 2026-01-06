import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { SupabaseService } from './supabase.service';
import { UnifiedFeedService } from './unified-feed.service';
import { UnifiedJob, AnalysisCacheEntry } from '../models/unified-job.model';
import { Resume } from '../models';

const ANALYSIS_CACHE_KEY = 'jobFeed_analysisCache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface AnalysisProgress {
  isProcessing: boolean;
  totalJobs: number;
  analyzedCount: number;
  currentJobId: string | null;
  progress: number; // 0-100
}

@Injectable({
  providedIn: 'root'
})
export class AnalysisQueueService {
  private queue: string[] = [];
  private processing = false;
  private currentResumeId: string | null = null;
  private analysisCache = new Map<string, AnalysisCacheEntry>();

  // Progress tracking
  private progressSubject = new BehaviorSubject<AnalysisProgress>({
    isProcessing: false,
    totalJobs: 0,
    analyzedCount: 0,
    currentJobId: null,
    progress: 0
  });

  // Event when analysis completes
  private analysisCompleteSubject = new Subject<{ jobId: string; success: boolean }>();

  progress$ = this.progressSubject.asObservable();
  analysisComplete$ = this.analysisCompleteSubject.asObservable();

  // Batch size for processing
  private readonly BATCH_SIZE = 3;

  constructor(
    private supabase: SupabaseService,
    private unifiedFeedService: UnifiedFeedService
  ) {
    this.loadCache();
  }

  /**
   * Get current progress
   */
  getProgress(): AnalysisProgress {
    return this.progressSubject.value;
  }

  /**
   * Add jobs to the analysis queue
   */
  addToQueue(jobIds: string[]): void {
    // Filter out already queued and already analyzed jobs
    const newIds = jobIds.filter(id => {
      if (this.queue.includes(id)) return false;
      if (this.currentResumeId && this.getCachedAnalysis(id, this.currentResumeId)) return false;
      return true;
    });

    this.queue.push(...newIds);

    this.updateProgress({
      totalJobs: this.queue.length + this.progressSubject.value.analyzedCount
    });
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.queue = [];
    this.updateProgress({
      isProcessing: false,
      totalJobs: 0,
      analyzedCount: 0,
      currentJobId: null,
      progress: 0
    });
  }

  /**
   * Process the analysis queue
   */
  async processQueue(resume: Resume): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    this.currentResumeId = resume.id;

    this.updateProgress({
      isProcessing: true,
      totalJobs: this.queue.length,
      analyzedCount: 0,
      progress: 0
    });

    try {
      while (this.queue.length > 0) {
        // Process in batches
        const batch = this.queue.splice(0, this.BATCH_SIZE);

        await Promise.all(batch.map(jobId => this.analyzeJob(jobId, resume)));

        // Update progress
        const analyzedCount = this.progressSubject.value.analyzedCount + batch.length;
        const total = this.progressSubject.value.totalJobs;
        const progress = total > 0 ? Math.round((analyzedCount / total) * 100) : 0;

        this.updateProgress({
          analyzedCount,
          progress
        });
      }
    } finally {
      this.processing = false;
      this.updateProgress({
        isProcessing: false,
        currentJobId: null,
        progress: 100
      });
    }
  }

  /**
   * Analyze a single job
   */
  private async analyzeJob(jobId: string, resume: Resume): Promise<void> {
    // Check cache first
    const cached = this.getCachedAnalysis(jobId, resume.id);
    if (cached) {
      this.unifiedFeedService.updateJobAnalysis(jobId, cached.result);
      this.analysisCompleteSubject.next({ jobId, success: true });
      return;
    }

    // Get the job from the feed
    const jobs = this.unifiedFeedService.getState().jobs;
    const job = jobs.find(j => j.id === jobId);
    if (!job) {
      this.analysisCompleteSubject.next({ jobId, success: false });
      return;
    }

    this.updateProgress({ currentJobId: jobId });
    this.unifiedFeedService.setJobAnalyzing(jobId, true);

    try {
      // Prepare job data for analysis
      const jobData = this.prepareJobForAnalysis(job);

      // Call the AI analysis
      const result = await this.supabase.analyzeMatchWithAI(resume, jobData);

      // Cache the result
      this.cacheAnalysis(jobId, resume.id, {
        match_score: result.match_score,
        matching_skills: result.matching_skills || [],
        missing_skills: result.missing_skills || [],
        recommendations: result.recommendations
      });

      // Update the job in the feed
      this.unifiedFeedService.updateJobAnalysis(jobId, {
        match_score: result.match_score,
        matching_skills: result.matching_skills || [],
        missing_skills: result.missing_skills || []
      });

      this.analysisCompleteSubject.next({ jobId, success: true });
    } catch (error) {
      console.error('Error analyzing job:', jobId, error);
      this.unifiedFeedService.setJobAnalyzing(jobId, false);
      this.analysisCompleteSubject.next({ jobId, success: false });
    }
  }

  /**
   * Prepare job data for AI analysis
   */
  private prepareJobForAnalysis(job: UnifiedJob): any {
    return {
      job_title: job.title,
      company_name: job.company,
      location: job.location,
      description_full: job.description,
      required_skills: this.extractSkillsFromJob(job),
      employment_type: job.employment_type,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      work_type: job.work_arrangement,
      years_experience_required: job.years_experience
    };
  }

  /**
   * Extract skills from job for analysis
   */
  private extractSkillsFromJob(job: UnifiedJob): { skill: string; importance: 'Required' | 'Preferred' }[] {
    const skills: { skill: string; importance: 'Required' | 'Preferred' }[] = [];

    // Add required skills from the job
    if (job.required_skills) {
      for (const skill of job.required_skills) {
        skills.push({ skill, importance: 'Required' });
      }
    }

    // Add tech stack skills
    if (job.tech_stack) {
      const allTech = [
        ...(job.tech_stack.frontend || []),
        ...(job.tech_stack.backend || []),
        ...(job.tech_stack.cloud || []),
        ...(job.tech_stack.other || [])
      ];
      for (const tech of allTech) {
        if (!skills.find(s => s.skill.toLowerCase() === tech.toLowerCase())) {
          skills.push({ skill: tech, importance: 'Required' });
        }
      }
    }

    // Extract skills from description using common skill keywords
    if (job.description && skills.length < 10) {
      const commonSkills = [
        'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP',
        'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'Spring', '.NET',
        'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'CI/CD', 'Git', 'Linux',
        'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch',
        'Machine Learning', 'AI', 'Data Science', 'TensorFlow', 'PyTorch',
        'Agile', 'Scrum', 'REST API', 'GraphQL', 'Microservices'
      ];

      const descLower = job.description.toLowerCase();
      for (const skill of commonSkills) {
        if (descLower.includes(skill.toLowerCase())) {
          if (!skills.find(s => s.skill.toLowerCase() === skill.toLowerCase())) {
            skills.push({ skill, importance: 'Preferred' });
          }
        }
      }
    }

    return skills;
  }

  /**
   * Get cached analysis for a job
   */
  getCachedAnalysis(jobId: string, resumeId: string): AnalysisCacheEntry | null {
    const key = this.getCacheKey(jobId, resumeId);
    const entry = this.analysisCache.get(key);

    if (entry && Date.now() < entry.expiresAt) {
      return entry;
    }

    // Remove expired entry
    if (entry) {
      this.analysisCache.delete(key);
      this.saveCache();
    }

    return null;
  }

  /**
   * Cache analysis result
   */
  private cacheAnalysis(jobId: string, resumeId: string, result: AnalysisCacheEntry['result']): void {
    const key = this.getCacheKey(jobId, resumeId);
    const entry: AnalysisCacheEntry = {
      jobId,
      resumeId,
      result,
      timestamp: Date.now(),
      expiresAt: Date.now() + CACHE_TTL
    };

    this.analysisCache.set(key, entry);
    this.saveCache();
  }

  /**
   * Invalidate cache for a specific resume
   * Called when the user switches resumes
   */
  invalidateForResume(resumeId: string): void {
    const keysToDelete: string[] = [];

    this.analysisCache.forEach((entry, key) => {
      if (entry.resumeId === resumeId) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => this.analysisCache.delete(key));
    this.saveCache();
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.analysisCache.clear();
    this.saveCache();
  }

  /**
   * Get cache key
   */
  private getCacheKey(jobId: string, resumeId: string): string {
    return `${resumeId}:${jobId}`;
  }

  /**
   * Update progress state
   */
  private updateProgress(updates: Partial<AnalysisProgress>): void {
    this.progressSubject.next({
      ...this.progressSubject.value,
      ...updates
    });
  }

  /**
   * Load cache from localStorage
   */
  private loadCache(): void {
    try {
      const stored = localStorage.getItem(ANALYSIS_CACHE_KEY);
      if (stored) {
        const entries: AnalysisCacheEntry[] = JSON.parse(stored);
        const now = Date.now();

        // Only load non-expired entries
        for (const entry of entries) {
          if (entry.expiresAt > now) {
            const key = this.getCacheKey(entry.jobId, entry.resumeId);
            this.analysisCache.set(key, entry);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load analysis cache:', e);
    }
  }

  /**
   * Save cache to localStorage
   */
  private saveCache(): void {
    try {
      const entries = Array.from(this.analysisCache.values());

      // Limit to 500 entries to prevent localStorage overflow
      const limitedEntries = entries
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 500);

      localStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify(limitedEntries));
    } catch (e) {
      console.error('Failed to save analysis cache:', e);
    }
  }
}
