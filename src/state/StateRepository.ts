import type { CryptoProvider } from "../crypto/CryptoProvider";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { isRecord } from "../util/validate";
import { SyncError } from "../errors/SyncError";
import { parseLocalState, type LocalState } from "./LocalState";

export interface StateRepository {
  /** Returns null if no (valid) state exists. Never throws for corrupt data. */
  load(): Promise<LocalState | null>;
  save(state: LocalState): Promise<void>;
}

/** Tiny binary key/value store over plugin-private files (implemented with the Obsidian DataAdapter). */
export interface BlobFileStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Crash-safe state persistence without atomic rename: every save writes a complete, checksummed copy to
 * `<name>.new` first, then to `<name>`. On load the primary is used if its checksum is valid, otherwise the
 * secondary. A torn write can therefore only ever damage one of the two copies.
 */
export class FileStateRepository implements StateRepository {
  /** An existing state file could not be read: it must never be overwritten with a fresh state. */
  private unreadable = false;

  constructor(
    private readonly store: BlobFileStore,
    private readonly crypto: CryptoProvider,
    private readonly path: string,
    private readonly expectedDeviceId: string,
    private readonly onCorrupt: (reason: string) => void = () => undefined,
  ) {}

  /**
   * The first valid copy, or null. Distinguishes "absent" from "present but unusable": unusable copies are
   * backed up to `<name>.corrupt-<time>` before a fresh state may replace them, and a copy that cannot even
   * be read (e.g. locked by antivirus or a cloud client) blocks saving until the next start.
   */
  async load(): Promise<LocalState | null> {
    const invalid: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const candidate of [this.path, `${this.path}.new`]) {
      const read = await this.readWithRetry(candidate);
      if (read === "unreadable") {
        this.unreadable = true;
        continue;
      }
      if (!read) continue;
      const state = await this.parse(read);
      if (state) {
        if (this.unreadable) this.onCorrupt("the primary sync state file could not be read; the backup copy is used and nothing is saved until Obsidian restarts");
        return state;
      }
      invalid.push({ path: candidate, bytes: read });
    }
    if (this.unreadable) {
      this.onCorrupt("the local sync state could not be read; it is kept untouched – restart Obsidian to synchronise again");
      return null;
    }
    if (invalid.length > 0) {
      const stamp = Date.now();
      for (const copy of invalid) await this.store.write(`${copy.path}.corrupt-${stamp}`, copy.bytes);
      this.onCorrupt("the local sync state was invalid and has been set aside; this device reconnects without deleting anything");
    }
    return null;
  }

  async save(state: LocalState): Promise<void> {
    if (this.unreadable) throw new SyncError("InvalidState", "the local sync state file could not be read; restart Obsidian before synchronising");
    const payload = JSON.stringify(state);
    const checksum = await this.crypto.hash(utf8Encode(payload));
    const data = utf8Encode(JSON.stringify({ checksum, payload }));
    await this.store.write(`${this.path}.new`, data);
    await this.store.write(this.path, data);
  }

  private async readWithRetry(path: string): Promise<Uint8Array | null | "unreadable"> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.store.read(path);
      } catch {
        // transient locks (antivirus, cloud clients): wait briefly and try again
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    return "unreadable";
  }

  private async parse(bytes: Uint8Array): Promise<LocalState | null> {
    try {
      const wrapper: unknown = JSON.parse(utf8Decode(bytes));
      if (!isRecord(wrapper) || typeof wrapper.payload !== "string" || typeof wrapper.checksum !== "string") return null;
      if ((await this.crypto.hash(utf8Encode(wrapper.payload))) !== wrapper.checksum) return null;
      const state = parseLocalState(JSON.parse(wrapper.payload));
      // A state copied from another device (e.g. by a second sync tool) could corrupt merges.
      return state.deviceId === this.expectedDeviceId ? state : null;
    } catch {
      return null;
    }
  }
}

/** In-memory repository for tests. Stores a deep copy on every save. */
export class MemoryStateRepository implements StateRepository {
  private snapshot: string | null = null;
  /** Failure injection: throw before persisting when set. */
  failNextSave: Error | null = null;
  saveCount = 0;

  async load(): Promise<LocalState | null> {
    return this.snapshot ? parseLocalState(JSON.parse(this.snapshot)) : null;
  }

  async save(state: LocalState): Promise<void> {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.snapshot = JSON.stringify(state);
    this.saveCount++;
  }
}
