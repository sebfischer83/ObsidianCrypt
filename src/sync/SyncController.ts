import { CryptoError } from "../errors/CryptoError";
import { RemoteError } from "../errors/RemoteError";
import { SyncError } from "../errors/SyncError";
import { describeError } from "../errors/VaultSyncError";
import { silentLogger, type Logger } from "../util/Logger";
import type { SyncMode, SyncReport } from "./SyncEngine";
import { SyncMutex } from "./SyncMutex";

export type SyncState = "notConfigured" | "locked" | "idle" | "syncing" | "offline" | "rateLimited" | "error" | "blocked";

export interface SyncStatus {
  readonly state: SyncState;
  readonly pending: number;
  readonly conflicts: number;
  readonly lastSync: number | null;
  readonly message: string | null;
}

export interface TriggerSettings {
  readonly autoSync: boolean;
  readonly syncOnStartup: boolean;
  readonly syncOnResume: boolean;
  readonly syncAfterChanges: boolean;
  /** Quiet period after the last change before a sync starts. */
  readonly debounceSeconds: number;
  /** Periodic sync interval, 0 = off (1–60). */
  readonly intervalMinutes: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
  now(): number;
}

export interface SyncControllerOptions {
  readonly runSync: (mode: SyncMode) => Promise<SyncReport>;
  readonly countPending: () => Promise<number>;
  readonly countConflicts: () => number;
  readonly isConfigured: () => boolean;
  readonly isUnlocked: () => boolean;
  readonly settings: () => TriggerSettings;
  readonly timers: Timers;
  readonly onStatus: (status: SyncStatus) => void;
  readonly onReport?: (report: SyncReport) => void;
  readonly onError?: (error: unknown) => void;
  readonly logger?: Logger;
}

const MIN_DEBOUNCE_MS = 2_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const RESUME_MIN_GAP_MS = 60_000;
const PENDING_REFRESH_MS = 5_000;

/**
 * Trigger logic (startup, debounced changes, interval, app resume, on demand) around the SyncMutex.
 * Independent of Obsidian; timers are injected. Never polls in the seconds range.
 */
export class SyncController {
  private readonly mutex = new SyncMutex();
  private debounceHandle: number | null = null;
  private pendingRefreshHandle: number | null = null;
  private intervalHandle: number | null = null;
  private retryHandle: number | null = null;
  private retryAttempt = 0;
  private status: SyncStatus = { state: "idle", pending: 0, conflicts: 0, lastSync: null, message: null };
  private lastAttempt = 0;
  private blocked = false;
  private stopped = false;
  private wantFull = false;
  private readonly log: Logger;

  constructor(private readonly o: SyncControllerOptions) {
    this.log = o.logger ?? silentLogger;
  }

  get current(): SyncStatus {
    return this.status;
  }

  get isSyncing(): boolean {
    return this.mutex.isRunning;
  }

  start(): void {
    this.stopped = false;
    this.rescheduleInterval();
    void this.refreshStatus();
    const s = this.o.settings();
    if (s.autoSync && s.syncOnStartup) void this.requestSync("full");
  }

  stop(): void {
    this.stopped = true;
    for (const h of [this.debounceHandle, this.retryHandle, this.pendingRefreshHandle]) if (h !== null) this.o.timers.clearTimeout(h);
    if (this.intervalHandle !== null) this.o.timers.clearInterval(this.intervalHandle);
    this.debounceHandle = this.retryHandle = this.intervalHandle = this.pendingRefreshHandle = null;
  }

  /** Call after settings changed. */
  rescheduleInterval(): void {
    if (this.intervalHandle !== null) this.o.timers.clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    const s = this.o.settings();
    const minutes = Math.min(60, Math.max(0, Math.round(s.intervalMinutes)));
    if (s.autoSync && minutes > 0) {
      this.intervalHandle = this.o.timers.setInterval(() => void this.requestSync("full"), minutes * 60_000);
    }
  }

  /** A file in the vault changed: debounce, then sync. */
  notifyChange(): void {
    if (this.stopped) return;
    const s = this.o.settings();
    // Throttled: counting pending changes scans the vault, so do it at most every few seconds.
    if (this.pendingRefreshHandle === null) {
      this.pendingRefreshHandle = this.o.timers.setTimeout(() => {
        this.pendingRefreshHandle = null;
        void this.refreshPendingSoon();
      }, PENDING_REFRESH_MS);
    }
    if (!s.autoSync || !s.syncAfterChanges) return;
    if (this.debounceHandle !== null) this.o.timers.clearTimeout(this.debounceHandle);
    const delay = Math.max(MIN_DEBOUNCE_MS, s.debounceSeconds * 1000);
    this.debounceHandle = this.o.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.requestSync("full");
    }, delay);
  }

  /** App returned to the foreground (mobile) / window focus. */
  notifyResume(): void {
    const s = this.o.settings();
    if (!s.autoSync || !s.syncOnResume) return;
    if (this.o.timers.now() - this.lastAttempt < RESUME_MIN_GAP_MS) return;
    void this.requestSync("full");
  }

  /** User explicitly asked to continue after a blocking condition was resolved. */
  clearBlock(): void {
    this.blocked = false;
  }

  /**
   * Runs a sync now (or marks it as requested if one is running). Resolves when this request is done;
   * errors are reported via status/onError and not rethrown (use {@link runNow} for that).
   */
  async requestSync(mode: SyncMode): Promise<void> {
    try {
      await this.runNow(mode);
    } catch (error: unknown) {
      this.o.onError?.(error);
    }
  }

  async runNow(mode: SyncMode): Promise<SyncReport | null> {
    if (this.stopped) return null;
    if (!this.o.isConfigured()) {
      this.setStatus({ state: "notConfigured", message: null });
      return null;
    }
    if (!this.o.isUnlocked()) {
      this.setStatus({ state: "locked", message: null });
      return null;
    }
    if (this.blocked && mode === "full") {
      // Stay blocked until the user acknowledges; do not hammer a manipulated repository.
      return null;
    }
    if (mode === "full") this.wantFull = true;
    // A request arriving while a sync runs only sets the mutex flag; the running owner loops once more.
    const outcome = await this.mutex.run(async () => {
      let last: SyncReport | null = null;
      do {
        const runMode: SyncMode = this.wantFull ? "full" : "pull";
        this.wantFull = false;
        last = await this.runOnce(runMode);
      } while (this.mutex.takeRequest() && !this.stopped);
      return last;
    });
    return outcome.ran ? outcome.value : null;
  }

  /** Runs a non-sync remote operation (e.g. password change) under the same mutex. */
  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const outcome = await this.mutex.run(task);
    if (!outcome.ran) throw new SyncError("InvalidState", "a synchronisation is running, try again in a moment");
    return outcome.value;
  }

  private async runOnce(mode: SyncMode): Promise<SyncReport> {
    this.lastAttempt = this.o.timers.now();
    this.setStatus({ state: "syncing", message: null });
    try {
      const report = await this.o.runSync(mode);
      this.retryAttempt = 0;
      if (this.retryHandle !== null) this.o.timers.clearTimeout(this.retryHandle);
      this.retryHandle = null;
      this.setStatus({ state: "idle", lastSync: this.o.timers.now(), message: null });
      this.o.onReport?.(report);
      if (report.morePending) this.scheduleRetry(1_000);
      await this.refreshStatus(true);
      return report;
    } catch (error: unknown) {
      await this.handleError(error);
      throw error;
    }
  }

  private async handleError(error: unknown): Promise<void> {
    const message = describeError(error);
    if (error instanceof SyncError && error.code === "Blocked") {
      this.blocked = true;
      this.setStatus({ state: "blocked", message });
      return;
    }
    if (error instanceof CryptoError && error.code === "Locked") {
      this.setStatus({ state: "locked", message });
      return;
    }
    if (error instanceof RemoteError) {
      if (error.category === "Network" || error.category === "ServerError") {
        this.setStatus({ state: "offline", message });
        this.scheduleRetry();
      } else if (error.category === "RateLimit") {
        this.setStatus({ state: "rateLimited", message });
        this.scheduleRetry(error.retryAfterMs ?? undefined);
      } else {
        this.setStatus({ state: "error", message });
      }
    } else if (error instanceof SyncError && error.code === "RetriesExhausted") {
      this.setStatus({ state: "error", message });
      this.scheduleRetry();
    } else {
      this.setStatus({ state: "error", message });
    }
    this.log.warn("sync failed", { retryAttempt: this.retryAttempt });
    await this.refreshStatus(true);
  }

  /** Exponential backoff for automatic retries: 30 s, 60 s, 2 min … capped at 15 min. */
  private scheduleRetry(explicitMs?: number): void {
    if (this.stopped || this.retryHandle !== null) return;
    const delay = explicitMs ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retryAttempt);
    this.retryAttempt++;
    this.retryHandle = this.o.timers.setTimeout(() => {
      this.retryHandle = null;
      void this.requestSync("full");
    }, Math.max(1_000, delay));
  }

  private pendingRefresh: Promise<void> | null = null;

  private refreshPendingSoon(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    this.pendingRefresh = this.refreshStatus().finally(() => {
      this.pendingRefresh = null;
    });
    return this.pendingRefresh;
  }

  /**
   * Recounts pending changes. `insideSync` = called by the sync owner itself (it holds the mutex, so
   * counting is safe); otherwise counting is skipped while a sync runs.
   */
  async refreshStatus(insideSync = false): Promise<void> {
    let pending = this.status.pending;
    if (this.o.isConfigured() && (insideSync || !this.mutex.isRunning)) {
      try {
        pending = await this.o.countPending();
      } catch (error: unknown) {
        this.log.debug("pending count failed", { unexpected: !(error instanceof Error) });
      }
    }
    let state = this.status.state;
    if (!this.o.isConfigured()) state = "notConfigured";
    else if (!this.o.isUnlocked() && state !== "syncing") state = "locked";
    else if (state === "notConfigured" || state === "locked") state = "idle";
    this.setStatus({ pending, conflicts: this.o.countConflicts(), state });
  }

  private setStatus(change: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...change };
    this.o.onStatus(this.status);
  }
}
