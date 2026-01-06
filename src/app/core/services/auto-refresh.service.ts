import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Observable, interval, Subscription } from 'rxjs';
import { takeUntil, map } from 'rxjs/operators';
import { RefreshConfig } from '../models/unified-job.model';

export interface RefreshState {
  isRefreshing: boolean;
  lastRefreshTime: Date | null;
  nextRefreshTime: Date | null;
  secondsUntilRefresh: number;
  isPaused: boolean;
}

const DEFAULT_CONFIG: RefreshConfig = {
  intervalMinutes: 15,
  enabled: true,
  maxJobsPerSource: 50
};

const CONFIG_STORAGE_KEY = 'jobFeed_refreshConfig';

@Injectable({
  providedIn: 'root'
})
export class AutoRefreshService implements OnDestroy {
  private destroy$ = new Subject<void>();
  private timerSubscription: Subscription | null = null;
  private countdownSubscription: Subscription | null = null;

  // State
  private stateSubject = new BehaviorSubject<RefreshState>({
    isRefreshing: false,
    lastRefreshTime: null,
    nextRefreshTime: null,
    secondsUntilRefresh: 0,
    isPaused: false
  });

  // Config
  private configSubject = new BehaviorSubject<RefreshConfig>(this.loadConfig());

  // Refresh trigger - components subscribe to this to know when to refresh
  private refreshTriggerSubject = new Subject<void>();

  // Public observables
  state$ = this.stateSubject.asObservable();
  config$ = this.configSubject.asObservable();
  refreshTrigger$ = this.refreshTriggerSubject.asObservable();

  constructor() {
    // Start the timer if enabled
    if (this.configSubject.value.enabled) {
      this.startTimer();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopTimer();
  }

  /**
   * Get current state
   */
  getState(): RefreshState {
    return this.stateSubject.value;
  }

  /**
   * Get current config
   */
  getConfig(): RefreshConfig {
    return this.configSubject.value;
  }

  /**
   * Start the auto-refresh timer
   */
  startTimer(): void {
    this.stopTimer(); // Clear any existing timer

    const config = this.configSubject.value;
    if (!config.enabled) return;

    const intervalMs = config.intervalMinutes * 60 * 1000;
    const nextRefreshTime = new Date(Date.now() + intervalMs);

    this.updateState({
      nextRefreshTime,
      isPaused: false
    });

    // Main refresh timer
    this.timerSubscription = interval(intervalMs)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (!this.stateSubject.value.isPaused) {
          this.triggerRefresh();
        }
      });

    // Countdown timer (updates every second)
    this.countdownSubscription = interval(1000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.updateCountdown();
      });
  }

  /**
   * Stop the auto-refresh timer
   */
  stopTimer(): void {
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }
    if (this.countdownSubscription) {
      this.countdownSubscription.unsubscribe();
      this.countdownSubscription = null;
    }
  }

  /**
   * Pause auto-refresh
   */
  pause(): void {
    this.updateState({ isPaused: true });
  }

  /**
   * Resume auto-refresh
   */
  resume(): void {
    const config = this.configSubject.value;
    const nextRefreshTime = new Date(Date.now() + config.intervalMinutes * 60 * 1000);

    this.updateState({
      isPaused: false,
      nextRefreshTime
    });
  }

  /**
   * Toggle pause/resume
   */
  togglePause(): void {
    if (this.stateSubject.value.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
   * Manually trigger a refresh
   */
  manualRefresh(): void {
    this.triggerRefresh();
  }

  /**
   * Set refreshing state (called by components when refresh starts/ends)
   */
  setRefreshing(isRefreshing: boolean): void {
    this.updateState({ isRefreshing });

    if (!isRefreshing) {
      // Refresh completed - update last refresh time and reset next refresh time
      const config = this.configSubject.value;
      const now = new Date();
      const nextRefreshTime = new Date(now.getTime() + config.intervalMinutes * 60 * 1000);

      this.updateState({
        lastRefreshTime: now,
        nextRefreshTime
      });
    }
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<RefreshConfig>): void {
    const newConfig = { ...this.configSubject.value, ...updates };
    this.configSubject.next(newConfig);
    this.saveConfig(newConfig);

    // Restart timer with new interval if enabled changed or interval changed
    if (updates.enabled !== undefined || updates.intervalMinutes !== undefined) {
      if (newConfig.enabled) {
        this.startTimer();
      } else {
        this.stopTimer();
        this.updateState({
          nextRefreshTime: null,
          secondsUntilRefresh: 0
        });
      }
    }
  }

  /**
   * Format seconds until refresh as a readable string
   */
  formatCountdown(seconds: number): string {
    if (seconds <= 0) return 'now';

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  }

  /**
   * Get countdown as an observable string
   */
  getCountdown$(): Observable<string> {
    return this.state$.pipe(
      map(state => {
        if (state.isPaused) return 'Paused';
        if (state.isRefreshing) return 'Refreshing...';
        return this.formatCountdown(state.secondsUntilRefresh);
      })
    );
  }

  // Private methods

  private triggerRefresh(): void {
    if (this.stateSubject.value.isRefreshing) return; // Don't trigger if already refreshing

    this.refreshTriggerSubject.next();
  }

  private updateCountdown(): void {
    const state = this.stateSubject.value;
    if (!state.nextRefreshTime || state.isPaused) {
      this.updateState({ secondsUntilRefresh: 0 });
      return;
    }

    const secondsUntilRefresh = Math.max(
      0,
      Math.floor((state.nextRefreshTime.getTime() - Date.now()) / 1000)
    );

    this.updateState({ secondsUntilRefresh });
  }

  private updateState(updates: Partial<RefreshState>): void {
    this.stateSubject.next({
      ...this.stateSubject.value,
      ...updates
    });
  }

  private loadConfig(): RefreshConfig {
    try {
      const stored = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('Failed to load refresh config:', e);
    }
    return DEFAULT_CONFIG;
  }

  private saveConfig(config: RefreshConfig): void {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save refresh config:', e);
    }
  }
}
