import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { firstValueFrom } from 'rxjs';

export interface ExternalJob {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  salary_min?: number;
  salary_max?: number;
  salary_text?: string;
  url: string;
  posted_date: string;
  source: 'adzuna' | 'rapidapi' | 'dice' | 'linkedin' | 'indeed' | 'glassdoor' | 'ai-search' | 'other';
  employment_type?: string;
  category?: string;
  work_type?: string;
  experience_level?: string;
  required_skills?: string[];
}

export interface JobSearchParams {
  query: string;
  location?: string;
  page?: number;
  resultsPerPage?: number;
  salaryMin?: number;
  salaryMax?: number;
  fullTime?: boolean;
  remote?: boolean;
  workType?: 'remote' | 'hybrid' | 'onsite';
  experienceLevel?: string;
  platforms?: string[];
}

export type JobPlatform = 'adzuna' | 'rapidapi' | 'dice' | 'linkedin' | 'indeed' | 'glassdoor' | 'ziprecruiter' | 'ai-search' | 'all';

export interface JobSearchResult {
  jobs: ExternalJob[];
  total: number;
  page: number;
  totalPages: number;
}

interface CacheEntry {
  data: JobSearchResult;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class JobFeedService {
  private adzunaBaseUrl = 'https://api.adzuna.com/v1/api/jobs';
  private rapidApiBaseUrl = 'https://jsearch.p.rapidapi.com';
  private supabaseFunctionsUrl = `${environment.supabaseUrl}/functions/v1`;

  // Cache for search results (5 minute TTL)
  private cache = new Map<string, CacheEntry>();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  // Track in-flight requests to prevent duplicates
  private pendingRequests = new Map<string, Promise<JobSearchResult>>();

  constructor(private http: HttpClient) {}

  /**
   * Generate cache key from search params
   */
  private getCacheKey(source: string, params: JobSearchParams, extra?: string): string {
    return `${source}:${params.query}:${params.location || ''}:${params.page || 1}:${extra || ''}`;
  }

  /**
   * Get from cache if valid
   */
  private getFromCache(key: string): JobSearchResult | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTTL) {
      return entry.data;
    }
    if (entry) {
      this.cache.delete(key);
    }
    return null;
  }

  /**
   * Save to cache
   */
  private saveToCache(key: string, data: JobSearchResult): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Search jobs from Adzuna API
   */
  async searchAdzunaJobs(params: JobSearchParams, country: string = 'us'): Promise<JobSearchResult> {
    const cacheKey = this.getCacheKey('adzuna', params, country);

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log('Returning cached Adzuna results');
      return cached;
    }

    // Check for pending request
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      console.log('Returning pending Adzuna request');
      return pending;
    }

    const page = params.page || 1;
    const resultsPerPage = params.resultsPerPage || 20;

    let url = `${this.adzunaBaseUrl}/${country}/search/${page}?app_id=${(environment as any).adzunaAppId || ''}&app_key=${(environment as any).adzunaApiKey || ''}&results_per_page=${resultsPerPage}`;

    if (params.query) {
      url += `&what=${encodeURIComponent(params.query)}`;
    }
    if (params.location) {
      url += `&where=${encodeURIComponent(params.location)}`;
    }
    if (params.salaryMin) {
      url += `&salary_min=${params.salaryMin}`;
    }
    if (params.salaryMax) {
      url += `&salary_max=${params.salaryMax}`;
    }
    if (params.fullTime) {
      url += `&full_time=1`;
    }

    const request = (async () => {
      try {
        const response: any = await firstValueFrom(this.http.get(url));

        const jobs: ExternalJob[] = (response.results || []).map((job: any) => ({
          id: job.id || `adzuna-${Date.now()}-${Math.random()}`,
          title: job.title || 'Unknown Title',
          company: job.company?.display_name || 'Unknown Company',
          location: job.location?.display_name || 'Unknown Location',
          description: job.description || '',
          salary_min: job.salary_min,
          salary_max: job.salary_max,
          salary_text: this.formatSalary(job.salary_min, job.salary_max),
          url: job.redirect_url || '',
          posted_date: job.created || new Date().toISOString(),
          source: 'adzuna' as const,
          employment_type: job.contract_type || 'Full-time',
          category: job.category?.label || ''
        }));

        const result: JobSearchResult = {
          jobs,
          total: response.count || 0,
          page,
          totalPages: Math.ceil((response.count || 0) / resultsPerPage)
        };

        this.saveToCache(cacheKey, result);
        return result;
      } catch (error) {
        console.error('Adzuna API error:', error);
        return { jobs: [], total: 0, page: 1, totalPages: 0 };
      } finally {
        this.pendingRequests.delete(cacheKey);
      }
    })();

    this.pendingRequests.set(cacheKey, request);
    return request;
  }

  /**
   * Search jobs from RapidAPI JSearch
   */
  async searchRapidApiJobs(params: JobSearchParams): Promise<JobSearchResult> {
    const cacheKey = this.getCacheKey('rapidapi', params);

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log('Returning cached RapidAPI results');
      return cached;
    }

    // Check for pending request
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      console.log('Returning pending RapidAPI request');
      return pending;
    }

    const page = params.page || 1;
    const resultsPerPage = params.resultsPerPage || 20;

    const headers = new HttpHeaders({
      'X-RapidAPI-Key': (environment as any).rapidApiKey || '',
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
    });

    let query = params.query || 'software developer';
    if (params.location) {
      query += ` in ${params.location}`;
    }

    const url = `${this.rapidApiBaseUrl}/search?query=${encodeURIComponent(query)}&page=${page}&num_pages=1`;

    const request = (async () => {
      try {
        const response: any = await firstValueFrom(this.http.get(url, { headers }));

        const jobs: ExternalJob[] = (response.data || []).map((job: any) => ({
          id: job.job_id || `rapid-${Date.now()}-${Math.random()}`,
          title: job.job_title || 'Unknown Title',
          company: job.employer_name || 'Unknown Company',
          location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') || 'Unknown Location',
          description: job.job_description || '',
          salary_min: job.job_min_salary,
          salary_max: job.job_max_salary,
          salary_text: this.formatSalary(job.job_min_salary, job.job_max_salary),
          url: job.job_apply_link || '',
          posted_date: job.job_posted_at_datetime_utc || new Date().toISOString(),
          source: 'rapidapi' as const,
          employment_type: job.job_employment_type || 'Full-time',
          category: job.job_job_title || ''
        }));

        const result: JobSearchResult = {
          jobs,
          total: response.data?.length || 0,
          page,
          totalPages: Math.ceil((response.data?.length || 0) / resultsPerPage)
        };

        this.saveToCache(cacheKey, result);
        return result;
      } catch (error) {
        console.error('RapidAPI error:', error);
        return { jobs: [], total: 0, page: 1, totalPages: 0 };
      } finally {
        this.pendingRequests.delete(cacheKey);
      }
    })();

    this.pendingRequests.set(cacheKey, request);
    return request;
  }

  /**
   * Search jobs from all sources
   */
  async searchAllJobs(params: JobSearchParams): Promise<JobSearchResult> {
    try {
      // Try Adzuna first (more reliable)
      const adzunaResult = await this.searchAdzunaJobs(params);

      if (adzunaResult.jobs.length > 0) {
        return adzunaResult;
      }

      // Fallback to RapidAPI if Adzuna returns no results
      return await this.searchRapidApiJobs(params);
    } catch (error) {
      console.error('Job search error:', error);
      return { jobs: [], total: 0, page: 1, totalPages: 0 };
    }
  }

  /**
   * Format salary range
   */
  private formatSalary(min?: number, max?: number): string {
    if (!min && !max) return '';

    const formatNum = (n: number) => {
      if (n >= 1000) {
        return `$${(n / 1000).toFixed(0)}k`;
      }
      return `$${n}`;
    };

    if (min && max) {
      return `${formatNum(min)} - ${formatNum(max)}`;
    }
    if (min) {
      return `From ${formatNum(min)}`;
    }
    if (max) {
      return `Up to ${formatNum(max)}`;
    }
    return '';
  }

  /**
   * Get job categories from Adzuna
   */
  async getCategories(country: string = 'us'): Promise<string[]> {
    const url = `${this.adzunaBaseUrl}/${country}/categories?app_id=${(environment as any).adzunaAppId || ''}&app_key=${(environment as any).adzunaApiKey || ''}`;

    try {
      const response: any = await firstValueFrom(this.http.get(url));
      return (response.results || []).map((cat: any) => cat.label);
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      return [];
    }
  }

  /**
   * Search jobs using AI-powered web search (Dice, LinkedIn, Indeed, etc.)
   * This uses Claude API to search across multiple job platforms
   */
  async searchWithAI(params: JobSearchParams, platforms: string[] = ['dice', 'indeed', 'linkedin']): Promise<JobSearchResult> {
    const cacheKey = this.getCacheKey('ai-search', params, platforms.sort().join(','));

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log('Returning cached AI search results');
      return cached;
    }

    // Check for pending request
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      console.log('Returning pending AI search request');
      return pending;
    }

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${environment.supabaseAnonKey}`
    });

    const requestBody = {
      query: params.query,
      location: params.location,
      platforms: platforms,
      workType: params.workType,
      experienceLevel: params.experienceLevel,
      salaryMin: params.salaryMin,
      salaryMax: params.salaryMax,
      limit: params.resultsPerPage || 15
    };

    const request = (async () => {
      try {
        const response: any = await firstValueFrom(
          this.http.post(`${this.supabaseFunctionsUrl}/search-jobs-ai`, requestBody, { headers })
        );

        const jobs: ExternalJob[] = (response.jobs || []).map((job: any) => ({
          id: job.id || `ai-${Date.now()}-${Math.random()}`,
          title: job.title || 'Unknown Title',
          company: job.company || 'Unknown Company',
          location: job.location || 'Unknown Location',
          description: job.description || '',
          salary_min: job.salary_min,
          salary_max: job.salary_max,
          salary_text: job.salary_text || this.formatSalary(job.salary_min, job.salary_max),
          url: job.url || '',
          posted_date: job.posted_date || new Date().toISOString(),
          source: this.normalizeSource(job.source),
          employment_type: job.employment_type || 'Full-time',
          work_type: job.work_type,
          experience_level: job.experience_level,
          required_skills: job.required_skills || [],
          category: ''
        }));

        const result: JobSearchResult = {
          jobs,
          total: response.total || jobs.length,
          page: params.page || 1,
          totalPages: Math.ceil((response.total || jobs.length) / (params.resultsPerPage || 15))
        };

        this.saveToCache(cacheKey, result);
        return result;
      } catch (error) {
        console.error('AI Search error:', error);
        return { jobs: [], total: 0, page: 1, totalPages: 0 };
      } finally {
        this.pendingRequests.delete(cacheKey);
      }
    })();

    this.pendingRequests.set(cacheKey, request);
    return request;
  }

  /**
   * Search specific platform using AI
   */
  async searchPlatform(platform: string, params: JobSearchParams): Promise<JobSearchResult> {
    return this.searchWithAI(params, [platform]);
  }

  /**
   * Normalize source string to match our type
   */
  private normalizeSource(source: string): ExternalJob['source'] {
    if (!source) return 'other';
    const normalized = source.toLowerCase().replace(/[^a-z]/g, '');
    switch (normalized) {
      case 'dice': return 'dice';
      case 'linkedin': return 'linkedin';
      case 'indeed': return 'indeed';
      case 'glassdoor': return 'glassdoor';
      case 'adzuna': return 'adzuna';
      case 'rapidapi': return 'rapidapi';
      case 'aisearch': return 'ai-search';
      default: return 'other';
    }
  }
}
