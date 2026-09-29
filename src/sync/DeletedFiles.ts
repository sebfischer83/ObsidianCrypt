import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { SyncError } from "../errors/SyncError";
import { isLive, isTombstone, type Manifest } from "../manifest/Manifest";
import type { RemoteRepository } from "../remote/RemoteRepository";
import type { SyncStateStore } from "../state/SyncStateStore";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { readObjectContent } from "./ChunkedContent";
import { createAtFreeName } from "./LocalContent";
import { restoredPath } from "./ConflictNaming";
import { readManifestAt } from "./HistoryReader";
import { HARD_MAX_FILE_SIZE } from "./SyncEngine";
import type { HistorySource } from "./VersionHistory";

export interface DeletedFile {
  readonly objectId: string;
  readonly deletedAtVersion: number;
  readonly deletedBy: string;
}

export interface ResolvedDeletedFile extends DeletedFile {
  readonly path: string;
  readonly size: number;
  readonly contentHash: string;
  /** Commit right before the deletion (contains the last version). */
  readonly contentCommit: string;
  /** Time of the deleting commit (commit metadata: informational only). */
  readonly deletedAt: number;
  /** 0 = current repository, n = n-th archived repository. */
  readonly source: number;
}

export interface DeletedFilesOptions {
  readonly crypto: CryptoProvider;
  readonly fs: LocalFileSystem;
  readonly remote: RemoteRepository;
  readonly store: SyncStateStore;
  readonly getKeys: () => VaultKeys;
  /** Earlier repositories of a moved vault, newest first. */
  readonly archives?: readonly HistorySource[];
}

/**
 * Files deleted on any device, recovered from the encrypted history. Tombstones carry neither path nor
 * hash (docs/DESIGN.md §3); both come from the manifest of the commit right before the deletion, whose
 * content hash then verifies the recovered content completely. Restoring creates a new file (new object
 * id); nothing existing is ever overwritten.
 */
export class DeletedFiles {
  private readonly manifests = new Map<string, Promise<Manifest>>();

  constructor(private readonly o: DeletedFilesOptions) {}

  /** Deleted files of the last synchronised manifest, most recently deleted first. No network access. */
  list(): DeletedFile[] {
    const entries = this.o.store.state.remote?.entries ?? {};
    const out: DeletedFile[] = [];
    for (const [objectId, entry] of Object.entries(entries)) {
      if (isTombstone(entry)) out.push({ objectId, deletedAtVersion: entry.deletedAtVersion, deletedBy: entry.deletedBy });
    }
    return out.sort((a, b) => b.deletedAtVersion - a.deletedAtVersion || (a.objectId < b.objectId ? -1 : 1));
  }

  /** Path, size and location of the last version, or null if it cannot be found in the history. */
  async resolve(file: DeletedFile): Promise<ResolvedDeletedFile | null> {
    const from = this.o.store.state.lastRemoteCommit;
    if (!from) return null;
    const sources = this.sources(from);
    for (const [index, source] of sources.entries()) {
      let deletion;
      try {
        [deletion] = await source.remote.listObjectRevisions(source.from, file.objectId, 1);
      } catch (error: unknown) {
        if (index === 0) throw error;
        return null;
      }
      // Never existed here (deleted before the vault moved) or only touched by the move: look further back.
      if (!deletion || deletion.migration) continue;
      const parents = await source.remote.getParents(deletion.commit);
      if (parents.length !== 1) return null;
      const contentCommit = parents[0] as string;
      const entry = (await this.manifestAt(index, source.remote, contentCommit)).entries[file.objectId];
      if (!isLive(entry)) return null;
      return { ...file, path: entry.path, size: entry.size, contentHash: entry.contentHash, contentCommit, deletedAt: deletion.date, source: index };
    }
    return null;
  }

  /** Decrypted content, verified against the manifest hash. */
  async load(file: ResolvedDeletedFile): Promise<Uint8Array> {
    const source = this.sources(this.o.store.state.lastRemoteCommit ?? "")[file.source];
    if (!source) throw new SyncError("InvalidState", "archive repository no longer known");
    return readObjectContent(source.remote, this.engine(), file.contentCommit, file.objectId, file.contentHash, Math.min(file.size, HARD_MAX_FILE_SIZE));
  }

  /** Writes the content at its old path, or next to it if that path is taken. Returns the path used. */
  async restore(file: ResolvedDeletedFile, content: Uint8Array): Promise<string> {
    return createAtFreeName(this.o.fs, content, (n) => (n === 0 ? file.path : restoredPath(file.path, n)));
  }

  private manifestAt(source: number, remote: RemoteRepository, commit: string): Promise<Manifest> {
    const key = `${source}:${commit}`;
    let pending = this.manifests.get(key);
    if (!pending) {
      pending = readManifestAt(remote, this.engine(), commit);
      pending.catch(() => this.manifests.delete(key));
      this.manifests.set(key, pending);
    }
    return pending;
  }

  private sources(from: string): HistorySource[] {
    return [{ remote: this.o.remote, from }, ...(this.o.archives ?? [])];
  }

  private engine(): EncryptionEngine {
    const keys = this.o.getKeys();
    if (keys.vaultId !== this.o.store.state.vaultId) throw SyncError.blocked("ForeignVault");
    return new EncryptionEngine(this.o.crypto, keys);
  }
}
