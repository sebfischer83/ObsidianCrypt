import type { CryptoProvider } from "../crypto/CryptoProvider";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { isRecord } from "../util/validate";
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
  constructor(
    private readonly store: BlobFileStore,
    private readonly crypto: CryptoProvider,
    private readonly path: string,
    private readonly expectedDeviceId: string,
    private readonly onCorrupt: (reason: string) => void = () => undefined,
  ) {}

  async load(): Promise<LocalState | null> {
    for (const candidate of [this.path, `${this.path}.new`]) {
      const state = await this.tryLoad(candidate);
      if (state) return state;
    }
    return null;
  }

  async save(state: LocalState): Promise<void> {
    const payload = JSON.stringify(state);
    const checksum = await this.crypto.hash(utf8Encode(payload));
    const data = utf8Encode(JSON.stringify({ checksum, payload }));
    await this.store.write(`${this.path}.new`, data);
    await this.store.write(this.path, data);
  }

  private async tryLoad(path: string): Promise<LocalState | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.read(path);
    } catch (error: unknown) {
      this.onCorrupt(`state file unreadable (${error instanceof Error ? error.name : "unknown"})`);
      return null;
    }
    if (!bytes) return null;
    try {
      const wrapper: unknown = JSON.parse(utf8Decode(bytes));
      if (!isRecord(wrapper) || typeof wrapper.payload !== "string" || typeof wrapper.checksum !== "string") {
        this.onCorrupt("state wrapper invalid");
        return null;
      }
      if ((await this.crypto.hash(utf8Encode(wrapper.payload))) !== wrapper.checksum) {
        this.onCorrupt("state checksum mismatch");
        return null;
      }
      const state = parseLocalState(JSON.parse(wrapper.payload));
      if (state.deviceId !== this.expectedDeviceId) {
        // Copied from another device (e.g. by a second sync tool). Using it could corrupt merges.
        this.onCorrupt("state belongs to another device");
        return null;
      }
      return state;
    } catch (error: unknown) {
      this.onCorrupt(`state invalid (${error instanceof Error ? error.name : "unknown"})`);
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
