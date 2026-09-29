import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { CryptoError } from "../errors/CryptoError";
import { RemoteError } from "../errors/RemoteError";
import { SyncError } from "../errors/SyncError";
import { describeError } from "../errors/VaultSyncError";
import { liveEntries } from "../manifest/Manifest";
import type { RemoteRepository } from "../remote/RemoteRepository";
import type { SyncStateStore } from "../state/SyncStateStore";
import { readChunkIndex, readObjectContent } from "./ChunkedContent";
import { readVerifiedHead } from "./HistoryReader";
import { HARD_MAX_FILE_SIZE } from "./SyncEngine";

export interface VerifyProblem {
  readonly path: string;
  readonly problem: "missing" | "corrupted";
}

export interface VerifyReport {
  readonly commit: string;
  readonly manifestVersion: number;
  /** Live files in the manifest. */
  readonly files: number;
  readonly totalBytes: number;
  /** Files downloaded, decrypted and matched against their manifest hash. */
  verified: number;
  readonly problems: VerifyProblem[];
  /** Objects in the tree that no live file references (harmless, e.g. left by an interrupted cleanup). */
  orphans: number;
  /** False if the backend truncated the object listing (orphans then unknown). */
  treeComplete: boolean;
  /** Set if the check stopped early (cancelled, network or rate limit); counts cover the part checked. */
  stopped: string | null;
}

export interface VerifyOptions {
  readonly crypto: CryptoProvider;
  readonly remote: RemoteRepository;
  readonly store: SyncStateStore;
  readonly getKeys: () => VaultKeys;
  readonly onProgress?: (done: number, total: number) => void;
  readonly isCancelled?: () => boolean;
}

/**
 * Read-only end-to-end check of the remote repository: configuration MAC, manifest authenticity and its
 * binding to the history, then every file downloaded, decrypted and compared with its manifest hash.
 * Never changes anything locally or remotely. Costs about one request per file (plus one per chunked file).
 */
export class RepositoryVerifier {
  constructor(private readonly o: VerifyOptions) {}

  async verify(): Promise<VerifyReport> {
    const state = this.o.store.state;
    const keys = this.o.getKeys();
    if (!state.vaultId) throw new SyncError("NotConfigured");
    if (keys.vaultId !== state.vaultId) throw SyncError.blocked("ForeignVault");
    const engine = new EncryptionEngine(this.o.crypto, keys);

    const head = await this.o.remote.getHead();
    if (head.kind !== "ok") throw state.lastRemoteCommit ? SyncError.blocked("BranchDeleted") : new SyncError("NotConfigured", "remote branch not initialised");
    const { commit, manifest } = await readVerifiedHead(this.o.remote, this.o.crypto, keys, state.deviceId);
    if (state.lastRemoteCommit && !(await this.o.remote.isAncestor(state.lastRemoteCommit, commit))) throw SyncError.blocked("HistoryRewritten");

    const files = liveEntries(manifest).sort((a, b) => (a[1].path < b[1].path ? -1 : 1));
    const report: VerifyReport = {
      commit,
      manifestVersion: manifest.version,
      files: files.length,
      totalBytes: files.reduce((sum, [, e]) => sum + e.size, 0),
      verified: 0,
      problems: [],
      orphans: 0,
      treeComplete: true,
      stopped: null,
    };

    const referenced = new Set<string>();
    for (const [index, [id, entry]] of files.entries()) {
      if (this.o.isCancelled?.()) {
        report.stopped = "Cancelled.";
        break;
      }
      this.o.onProgress?.(index, files.length);
      referenced.add(id);
      try {
        if (entry.chunks !== undefined) {
          const chunks = await readChunkIndex(this.o.remote, engine, commit, id);
          for (const chunk of chunks) referenced.add(chunk.id);
          if (chunks.length !== entry.chunks) throw new CryptoError("IntegrityMismatch", "chunk count");
        }
        const content = await readObjectContent(this.o.remote, engine, commit, id, entry.contentHash, Math.min(entry.size, HARD_MAX_FILE_SIZE));
        if (content.length !== entry.size) throw new CryptoError("IntegrityMismatch", "size");
        content.fill(0);
        report.verified++;
      } catch (error: unknown) {
        if (error instanceof RemoteError && error.category === "NotFound") report.problems.push({ path: entry.path, problem: "missing" });
        else if (error instanceof CryptoError) report.problems.push({ path: entry.path, problem: "corrupted" });
        else {
          report.stopped = describeError(error);
          break;
        }
      }
    }
    this.o.onProgress?.(files.length, files.length);

    if (report.stopped === null) {
      const listing = await this.o.remote.listObjectIds(commit);
      report.treeComplete = listing.complete;
      report.orphans = listing.ids.filter((id) => !referenced.has(id)).length;
    }
    return report;
  }
}
