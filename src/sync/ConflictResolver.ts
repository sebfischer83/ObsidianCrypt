import type { CryptoProvider } from "../crypto/CryptoProvider";
import { SyncError } from "../errors/SyncError";
import type { ConflictRecord } from "../state/LocalState";
import type { SyncStateStore } from "../state/SyncStateStore";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { isSyncedContent, trackedObjectId } from "./LocalContent";

export interface ConflictSides {
  /** Content at the canonical path (the version that won the name), null if the file is gone. */
  readonly synced: Uint8Array | null;
  /** Content of the preserved copy, null if there is none. */
  readonly copy: Uint8Array | null;
}

/**
 * Resolves a conflict that left two files (canonical path + conflict copy). Nothing is lost:
 * the discarded copy goes to the vault trash, and the canonical content is only overwritten if it is
 * stored in the remote history. All operations re-check that the files still have the content the user
 * compared.
 */
export class ConflictResolver {
  constructor(
    private readonly o: {
      readonly crypto: CryptoProvider;
      readonly fs: LocalFileSystem;
      readonly store: SyncStateStore;
    },
  ) {}

  async load(conflict: ConflictRecord): Promise<ConflictSides> {
    return { synced: await this.readIfExists(conflict.path), copy: conflict.conflictPath ? await this.readIfExists(conflict.conflictPath) : null };
  }

  /** True if the canonical file's content is in the remote history (so "keep copy" may replace it). */
  async canReplaceSynced(conflict: ConflictRecord): Promise<boolean> {
    const id = trackedObjectId(this.o.store.state, conflict.path);
    return id !== null && isSyncedContent(this.o.store.state, this.o.crypto, this.o.fs, conflict.path, id);
  }

  /** Keeps the canonical version: the copy (if unchanged since compared) moves to the trash. */
  async keepSynced(conflict: ConflictRecord, expectedCopyHash: string): Promise<void> {
    const copy = this.requireCopyPath(conflict);
    await this.expectHash(copy, expectedCopyHash);
    await this.o.fs.trash(copy);
    await this.dismiss(conflict);
  }

  /**
   * Keeps the copy: its content replaces the canonical file, then the copy moves to the trash.
   * Must run under the SyncMutex. Throws SyncError("UnsyncedChanges") if the canonical content is not in
   * the remote history yet.
   */
  async keepCopy(conflict: ConflictRecord, expectedCopyHash: string): Promise<void> {
    const copy = this.requireCopyPath(conflict);
    const content = await this.expectHash(copy, expectedCopyHash);
    if (!(await this.canReplaceSynced(conflict))) throw new SyncError("UnsyncedChanges");
    await this.o.fs.write(conflict.path, content);
    await this.o.fs.trash(copy);
    await this.dismiss(conflict);
  }

  async dismiss(conflict: ConflictRecord): Promise<void> {
    const state = this.o.store.state;
    state.conflicts = state.conflicts.filter((c) => c.id !== conflict.id);
    await this.o.store.persist();
  }

  private requireCopyPath(conflict: ConflictRecord): string {
    if (!conflict.conflictPath) throw new SyncError("InvalidState", "this conflict has no copy");
    return conflict.conflictPath;
  }

  private async expectHash(path: string, expected: string): Promise<Uint8Array> {
    const data = await this.readIfExists(path);
    if (!data || (await this.o.crypto.hash(data)) !== expected) throw new SyncError("InvalidState", "the file changed since it was compared; compare again");
    return data;
  }

  private async readIfExists(path: string): Promise<Uint8Array | null> {
    if (!(await this.o.fs.stat(path))) return null;
    return this.o.fs.read(path);
  }
}
