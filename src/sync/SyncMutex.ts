/**
 * Guarantees that at most one synchronisation runs at a time. A request arriving while a sync is running
 * sets `syncRequested`; the owner runs again afterwards instead of starting a parallel sync.
 */
export class SyncMutex {
  private running = false;
  private requested = false;

  get isRunning(): boolean {
    return this.running;
  }

  get syncRequested(): boolean {
    return this.requested;
  }

  /**
   * Runs `task` exclusively. If a run is already in progress the request is recorded and
   * `{ ran: false }` is returned immediately.
   */
  async run<T>(task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.running) {
      this.requested = true;
      return { ran: false };
    }
    this.running = true;
    this.requested = false;
    try {
      return { ran: true, value: await task() };
    } finally {
      this.running = false;
    }
  }

  /** Consumes a pending request flag (returns true if another sync was requested meanwhile). */
  takeRequest(): boolean {
    const r = this.requested;
    this.requested = false;
    return r;
  }
}
