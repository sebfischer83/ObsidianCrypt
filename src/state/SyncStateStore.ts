import { newLocalState, type LocalState } from "./LocalState";
import type { StateRepository } from "./StateRepository";

/**
 * In-memory owner of the LocalState, shared by the sync engine and the vault event handlers.
 * Persisting is serialised so two saves never interleave.
 */
export class SyncStateStore {
  private current: LocalState;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    private readonly repository: StateRepository,
    initial: LocalState,
  ) {
    this.current = initial;
  }

  static async open(repository: StateRepository, deviceId: string): Promise<SyncStateStore> {
    const loaded = await repository.load();
    return new SyncStateStore(repository, loaded && loaded.deviceId === deviceId ? loaded : newLocalState(deviceId));
  }

  get state(): LocalState {
    return this.current;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Replaces the whole state (setup / reconnect). */
  reset(state: LocalState): void {
    this.current = state;
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  persist(): Promise<void> {
    const run = async (): Promise<void> => {
      this.dirty = false;
      await this.repository.save(this.current);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Keeps object identity stable across renames/moves performed in Obsidian. Called from the vault
   * "rename" event for files and folders. Own sync operations update the map first, so their events
   * become no-ops here.
   */
  recordRename(from: string, to: string): boolean {
    const map = this.current.localMap;
    let changed = false;
    const direct = map[from];
    if (direct !== undefined && map[to] === undefined) {
      delete map[from];
      map[to] = direct;
      changed = true;
    }
    const prefix = `${from}/`;
    for (const path of Object.keys(map)) {
      if (path.startsWith(prefix)) {
        const target = `${to}/${path.slice(prefix.length)}`;
        if (map[target] === undefined) {
          map[target] = map[path] as string;
          delete map[path];
          changed = true;
        }
      }
    }
    for (const path of Object.keys(this.current.hashCache)) {
      if (path === from || path.startsWith(prefix)) {
        const target = path === from ? to : `${to}/${path.slice(prefix.length)}`;
        const entry = this.current.hashCache[path];
        delete this.current.hashCache[path];
        if (entry) this.current.hashCache[target] = entry;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }
}
