import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { GitHubError } from "../errors/GitHubError";
import { SyncError } from "../errors/SyncError";
import { isLive } from "../manifest/Manifest";
import type { ObjectRevision, RemoteRepository } from "../remote/RemoteRepository";
import type { SyncStateStore } from "../state/SyncStateStore";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { isSyncedContent, trackedObjectId } from "./LocalContent";
import { readObjectContent } from "./ChunkedContent";
import { versionCopyPath } from "./ConflictNaming";
import { HARD_MAX_FILE_SIZE } from "./SyncEngine";

/** Upper bound for the number of listed versions (GitHub returns at most 100 commits per page). */
export const MAX_VERSION_LIMIT = 100;

export interface FileVersion extends ObjectRevision {
  readonly objectId: string;
}

export type RestoreOutcome = "restored" | "unchanged";

export interface VersionHistoryOptions {
  readonly crypto: CryptoProvider;
  readonly fs: LocalFileSystem;
  readonly remote: RemoteRepository;
  readonly store: SyncStateStore;
  /** Returns the unlocked keys or throws CryptoError("Locked"). */
  readonly getKeys: () => VaultKeys;
}

/**
 * Earlier versions of a file, read from the encrypted remote history. Every push rewrites
 * `objects/<aa>/<objectId>`, so the commits touching that path are exactly the file's versions; nothing
 * extra is stored locally or remotely. The history is never pruned (fast-forward-only branch), so the
 * configured limit only bounds how many versions are listed.
 *
 * Restoring never loses data: the current content is only replaced if it is part of the remote history
 * itself, and the restored content is uploaded as a new version by the next sync.
 */
export class VersionHistory {
  constructor(private readonly o: VersionHistoryOptions) {}

  /** Object id tracked for a vault path, or null if the file was never synchronised. */
  objectIdFor(path: string): string | null {
    return trackedObjectId(this.o.store.state, path);
  }

  /** Versions of the file as of the last synchronised commit, newest first. */
  async list(path: string, limit: number): Promise<FileVersion[]> {
    const from = this.o.store.state.lastRemoteCommit;
    const objectId = this.objectIdFor(path);
    if (!from || !objectId) return [];
    const bounded = Math.min(MAX_VERSION_LIMIT, Math.max(1, Math.floor(limit)));
    const revisions = await this.o.remote.listObjectRevisions(from, objectId, bounded);
    return revisions.slice(0, bounded).map((r) => ({ ...r, objectId }));
  }

  /** Decrypted content of a version, or null if the file was removed in that commit. */
  async load(version: FileVersion): Promise<Uint8Array | null> {
    const keys = this.o.getKeys();
    if (keys.vaultId !== this.o.store.state.vaultId) throw SyncError.blocked("ForeignVault");
    const engine = new EncryptionEngine(this.o.crypto, keys);
    try {
      return await readObjectContent(this.o.remote, engine, version.commit, version.objectId, null, HARD_MAX_FILE_SIZE);
    } catch (error: unknown) {
      if (error instanceof GitHubError && error.category === "NotFound") return null;
      throw error;
    }
  }

  /** True if the file's current content is stored in the remote history (replacing it loses nothing). */
  async isCurrentContentSynced(path: string, objectId: string): Promise<boolean> {
    return isSyncedContent(this.o.store.state, this.o.crypto, this.o.fs, path, objectId);
  }

  /**
   * Replaces the file's content with `content` (a loaded version). Must run under the SyncMutex.
   * Throws SyncError("UnsyncedChanges") if the current content is not in the remote history.
   */
  async restore(path: string, version: FileVersion, content: Uint8Array): Promise<RestoreOutcome> {
    if (this.objectIdFor(path) !== version.objectId) throw new SyncError("InvalidState", "the file was replaced; reopen the version history");
    const currentHash = await this.o.crypto.hash(await this.o.fs.read(path));
    if (currentHash === (await this.o.crypto.hash(content))) return "unchanged";
    const entry = this.o.store.state.remote?.entries[version.objectId];
    if (!isLive(entry) || entry.contentHash !== currentHash) throw new SyncError("UnsyncedChanges");
    await this.o.fs.write(path, content);
    return "restored";
  }

  /** Writes a version next to the file as a new file and returns its path. The original stays untouched. */
  async restoreAsCopy(path: string, version: FileVersion, content: Uint8Array): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const candidate = versionCopyPath(path, version.date, n);
      if (await this.o.fs.exists(candidate)) continue;
      await this.o.fs.write(candidate, content);
      return candidate;
    }
    throw new SyncError("InvalidState", "no free file name for the restored copy");
  }
}
