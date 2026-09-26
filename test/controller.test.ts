import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/errors/GitHubError";
import { SyncError } from "../src/errors/SyncError";
import { SyncController, type SyncStatus, type Timers, type TriggerSettings } from "../src/sync/SyncController";
import type { SyncMode, SyncReport } from "../src/sync/SyncEngine";

class FakeTimers implements Timers {
  private t = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: number): void {
    this.tasks.delete(h);
  }
  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(h: number): void {
    this.tasks.delete(h);
  }
  now(): number {
    return this.t;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.t = task.at;
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
      await flush();
    }
    this.t = end;
  }
  pending(): number {
    return this.tasks.size;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const REPORT: SyncReport = {
  downloaded: 0, localMoves: 0, localDeletes: 0, uploaded: 0, remoteDeletes: 0, commits: [], newConflicts: [],
  failedLocalOps: 0, skippedFiles: 0, nameCollisions: [], morePending: false, recoveredJournal: false, recoveredCommit: false,
};

function setup(settings: Partial<TriggerSettings> = {}, behaviour: (mode: SyncMode, n: number) => Promise<SyncReport> = async () => REPORT) {
  const timers = new FakeTimers();
  const calls: SyncMode[] = [];
  const statuses: SyncStatus[] = [];
  const s: TriggerSettings = { autoSync: true, syncOnStartup: false, syncOnResume: true, syncAfterChanges: true, debounceSeconds: 30, intervalMinutes: 0, ...settings };
  const controller = new SyncController({
    runSync: (mode) => {
      calls.push(mode);
      return behaviour(mode, calls.length);
    },
    countPending: async () => 0,
    countConflicts: () => 0,
    isConfigured: () => true,
    isUnlocked: () => true,
    settings: () => s,
    timers,
    onStatus: (st) => statuses.push(st),
  });
  return { controller, timers, calls, statuses };
}

describe("sync controller (§17, §18, §35)", () => {
  it("debounces bursts of changes into one sync", async () => {
    const { controller, timers, calls } = setup();
    controller.start();
    for (let i = 0; i < 10; i++) {
      controller.notifyChange();
      await timers.advance(5_000);
    }
    expect(calls).toHaveLength(0);
    await timers.advance(30_000);
    expect(calls).toEqual(["full"]);
  });

  it("a request during a running sync causes exactly one follow-up run, never a parallel one", async () => {
    let release: () => void = () => undefined;
    let running = 0;
    let maxParallel = 0;
    const { controller, calls } = setup({}, async (_m, n) => {
      running++;
      maxParallel = Math.max(maxParallel, running);
      if (n === 1) await new Promise<void>((r) => (release = r));
      running--;
      return REPORT;
    });
    const first = controller.runNow("full");
    await flush();
    await controller.runNow("full");
    await controller.runNow("full");
    release();
    await first;
    expect(calls).toEqual(["full", "full"]);
    expect(maxParallel).toBe(1);
  });

  it("retries network failures with growing backoff", async () => {
    let fail = true;
    const { controller, timers, calls, statuses } = setup({}, async () => {
      if (fail) throw new GitHubError("Network");
      return REPORT;
    });
    await controller.requestSync("full");
    expect(statuses.at(-1)?.state).toBe("offline");
    await timers.advance(30_000);
    expect(calls).toHaveLength(2);
    await timers.advance(59_000);
    expect(calls).toHaveLength(2);
    fail = false;
    await timers.advance(1_000);
    expect(calls).toHaveLength(3);
    expect(statuses.at(-1)?.state).toBe("idle");
  });

  it("stays blocked after a manipulation was detected", async () => {
    const { controller, timers, calls, statuses } = setup({ intervalMinutes: 1 }, async () => {
      throw SyncError.blocked("HistoryRewritten");
    });
    controller.start();
    await controller.requestSync("full");
    expect(statuses.at(-1)?.state).toBe("blocked");
    await timers.advance(10 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it("periodic sync respects the configured interval and never polls in seconds", async () => {
    const { controller, timers, calls } = setup({ intervalMinutes: 5 });
    controller.start();
    await timers.advance(4 * 60_000);
    expect(calls).toHaveLength(0);
    await timers.advance(60_000);
    expect(calls).toHaveLength(1);
    await timers.advance(10 * 60_000);
    expect(calls).toHaveLength(3);
  });
});
