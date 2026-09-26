import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { CryptoError } from "../errors/CryptoError";
import { SyncError } from "../errors/SyncError";
import { emptyManifest, entriesEquivalent, isLive, MANIFEST_TYPE, type Manifest, type ManifestEntry } from "../manifest/Manifest";
import { decodeManifest, encodeManifest } from "../manifest/ManifestCodec";
import { parseVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
import { buildCommitMessage } from "../remote/RemoteLayout";
import type { RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import type { ConflictRecord, LocalState } from "../state/LocalState";
import type { SyncStateStore } from "../state/SyncStateStore";
import { toHex, utf8Decode } from "../util/bytes";
import { silentLogger, type Logger } from "../util/Logger";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { IgnoreMatcher } from "../vault/IgnoreMatcher";
import { DEFAULT_IGNORE_RULES, IGNORE_FILE, SyncFilter, type FilterSettings } from "../vault/SyncFilter";
import { scanVault } from "../vault/VaultScanner";
import { applyLocalOps } from "../vault/VaultWriter";
import { buildLocalView, type LocalView } from "./ChangeDetector";
import { planPull, planPush, type PlanContext } from "./SyncPlanner";

export interface SyncLimits {
  /** Files larger than this are not synchronised (GitHub hard limit is 100 MB per file). */
  readonly maxFileSize: number;
  /** Maximum number of uploaded objects per commit. */
  readonly maxFilesPerCommit: number;
  /** Maximum plaintext bytes per commit (bounds memory usage). */
  readonly maxBytesPerCommit: number;
  /** Maximum commits created in one sync run (large initial uploads continue in the next run). */
  readonly maxCommitsPerRun: number;
  /** How often a push is retried after another device pushed concurrently. */
  readonly maxConcurrentRetries: number;
}

export const DEFAULT_LIMITS: SyncLimits = {
  maxFileSize: 50 * 1024 * 1024,
  maxFilesPerCommit: 500,
  maxBytesPerCommit: 64 * 1024 * 1024,
  maxCommitsPerRun: 20,
  maxConcurrentRetries: 3,
};

/** Base64 request bodies must stay below GitHub's 100 MB limit (72 MiB × 4/3 ≈ 96 MiB). */
export const HARD_MAX_FILE_SIZE = 72 * 1024 * 1024;

export type SyncMode = "full" | "pull";

export interface SyncReport {
  downloaded: number;
  localMoves: number;
  localDeletes: number;
  uploaded: number;
  remoteDeletes: number;
  commits: string[];
  newConflicts: ConflictRecord[];
  failedLocalOps: number;
  skippedFiles: number;
  nameCollisions: string[];
  morePending: boolean;
  recoveredJournal: boolean;
  recoveredCommit: boolean;
}

export interface SyncEngineOptions {
  readonly crypto: CryptoProvider;
  readonly fs: LocalFileSystem;
  readonly remote: RemoteRepository;
  readonly store: SyncStateStore;
  /** Returns the unlocked keys or throws CryptoError("Locked"). */
  readonly getKeys: () => VaultKeys;
  readonly filterSettings: FilterSettings;
  readonly limits?: Partial<SyncLimits>;
  readonly deviceId: string;
  readonly now?: () => number;
  readonly logger?: Logger;
}

type PushOutcome = "nothing" | "done" | "more" | "concurrent";

/**
 * Deterministic synchronisation (docs/DESIGN.md §5). Must be called under the SyncMutex.
 */
export class SyncEngine {
  private readonly limits: SyncLimits;
  private readonly now: () => number;
  private readonly log: Logger;
  /** Last validated remote configuration (for UI / password change). */
  lastConfig: PublicVaultConfig | null = null;

  constructor(private readonly o: SyncEngineOptions) {
    const merged = { ...DEFAULT_LIMITS, ...o.limits };
    this.limits = { ...merged, maxFileSize: Math.min(merged.maxFileSize, HARD_MAX_FILE_SIZE) };
    this.now = o.now ?? (() => Date.now());
    this.log = o.logger ?? silentLogger;
  }

  private get state(): LocalState {
    return this.o.store.state;
  }

  async sync(mode: SyncMode = "full"): Promise<SyncReport> {
    const report: SyncReport = {
      downloaded: 0,
      localMoves: 0,
      localDeletes: 0,
      uploaded: 0,
      remoteDeletes: 0,
      commits: [],
      newConflicts: [],
      failedLocalOps: 0,
      skippedFiles: 0,
      nameCollisions: [],
      morePending: false,
      recoveredJournal: false,
      recoveredCommit: false,
    };
    const state = this.state;
    if (!state.vaultId) throw new SyncError("NotConfigured");
    const keys = this.o.getKeys();
    if (keys.vaultId !== state.vaultId) throw SyncError.blocked("ForeignVault");
    const engine = new EncryptionEngine(this.o.crypto, keys);

    let concurrent = 0;
    for (;;) {
      const head = await this.fetchHead();
      await this.recoverPendingCommit(head, report);
      await this.recoverJournal(engine, report);
      const remote = await this.loadRemote(head, engine, keys);
      const filter = await this.buildFilter();

      await this.pullPhase(head, remote, engine, filter, report);
      if (mode === "pull") {
        await this.o.store.persist();
        return report;
      }

      const outcome = await this.pushPhase(head, remote, engine, filter, report);
      if (outcome === "concurrent") {
        concurrent++;
        this.log.info("concurrent remote update, retrying", { attempt: concurrent });
        if (concurrent > this.limits.maxConcurrentRetries) throw new SyncError("RetriesExhausted");
        continue;
      }
      if (outcome === "more") {
        if (report.commits.length < this.limits.maxCommitsPerRun) continue;
        report.morePending = true;
      }
      this.state.lastSyncTime = this.now();
      await this.o.store.persist();
      return report;
    }
  }

  /** Number of local changes that would be uploaded by the next sync (for the status bar). */
  async countPendingChanges(): Promise<number> {
    const state = this.state;
    if (!state.vaultId) return 0;
    const filter = await this.buildFilter();
    const scan = await scanVault(this.o.fs, filter, state.hashCache, this.o.crypto, this.limits);
    const view = await buildLocalView(scan, { ...state.localMap }, state.base, filter, this.o.fs);
    let count = view.deleted.size + view.untracked.size;
    for (const [id, file] of view.present) {
      const b = state.base[id];
      if (!isLive(b) || b.path !== file.path || b.contentHash !== file.hash) count++;
    }
    return count;
  }

  // ───────────────────────── steps ─────────────────────────

  private async fetchHead(): Promise<string> {
    const head = await this.o.remote.getHead();
    if (head.kind === "ok") return head.commit;
    if (this.state.lastRemoteCommit !== null) throw SyncError.blocked("BranchDeleted");
    throw new SyncError("NotConfigured", "remote branch not initialised");
  }

  private async recoverPendingCommit(head: string, report: SyncReport): Promise<void> {
    const pending = this.state.pendingCommit;
    if (!pending) return;
    if (pending.commit === head || (await this.o.remote.isAncestor(pending.commit, head))) {
      // The branch moved to our commit before we could record it: finalise now.
      this.finalizeCommit(pending.commit, pending.manifest);
      report.recoveredCommit = true;
      this.log.info("recovered pending commit");
    } else {
      this.state.pendingCommit = null;
      this.log.info("discarded unpublished commit");
    }
    await this.o.store.persist();
  }

  private async recoverJournal(engine: EncryptionEngine, report: SyncReport): Promise<void> {
    if (!this.state.journal) return;
    this.log.info("resuming interrupted local apply");
    await this.executeJournal(engine, true, report);
    report.recoveredJournal = true;
  }

  private async loadRemote(head: string, engine: EncryptionEngine, keys: VaultKeys): Promise<Manifest> {
    const state = this.state;
    if (head === state.lastRemoteCommit && state.remote) return state.remote;
    const vaultId = state.vaultId as string;

    const configBytes = await this.o.remote.readConfig(head);
    if (!configBytes) throw SyncError.blocked("ConfigMissing");
    const config = parseVaultConfig(configBytes);
    if (config.vaultId !== vaultId) throw SyncError.blocked("ForeignVault");
    if (!(await keys.verifyConfigMac(this.o.crypto, config))) throw SyncError.blocked("ConfigCorrupted");
    this.lastConfig = config;

    let manifest: Manifest;
    const manifestBytes = await this.o.remote.readManifest(head);
    if (!manifestBytes) {
      if (!(await this.o.remote.isBootstrapCommit(head))) throw SyncError.blocked("ManifestMissing");
      manifest = emptyManifest(vaultId, this.o.deviceId);
    } else {
      let plaintext: Uint8Array;
      try {
        plaintext = await engine.decryptManifest(manifestBytes);
      } catch (error: unknown) {
        if (error instanceof CryptoError && error.code === "UnsupportedFormat") throw SyncError.blocked("UnknownFormatVersion", { cause: error });
        if (error instanceof CryptoError) throw SyncError.blocked("ManifestCorrupted", { cause: error });
        throw error;
      }
      manifest = decodeManifest(plaintext, vaultId);
      // Bind the manifest to its place in the history: every commit carrying a manifest was created
      // directly on top of manifest.parentCommit. A replayed older manifest (appended by someone with
      // repository write access but without the key) fails this check.
      const parents = await this.o.remote.getParents(head);
      if (parents.length !== 1 || parents[0] !== manifest.parentCommit) throw SyncError.blocked("HistoryRewritten");
    }

    if (state.lastRemoteCommit !== null) {
      if (manifest.version < state.lastManifestVersion) throw SyncError.blocked("HistoryRewritten");
      if (!(await this.o.remote.isAncestor(state.lastRemoteCommit, head))) throw SyncError.blocked("HistoryRewritten");
    }
    return manifest;
  }

  private async buildFilter(): Promise<SyncFilter> {
    const rules = [...DEFAULT_IGNORE_RULES];
    try {
      if (await this.o.fs.exists(IGNORE_FILE)) rules.push(...utf8Decode(await this.o.fs.read(IGNORE_FILE)).split(/\r?\n/));
    } catch (error: unknown) {
      // An unreadable ignore file must not silently include files the user wanted excluded.
      throw new SyncError("InvalidState", "ignore file unreadable", { cause: error });
    }
    return new SyncFilter(this.o.filterSettings, new IgnoreMatcher(rules));
  }

  private planContext(): PlanContext {
    return {
      deviceId: this.o.deviceId,
      now: this.now(),
      newObjectId: () => toHex(this.o.crypto.randomBytes(16)),
      randomToken: () => toHex(this.o.crypto.randomBytes(3)),
      maxFileSize: this.limits.maxFileSize,
    };
  }

  private async scanAndView(filter: SyncFilter): Promise<{ view: LocalView; skipped: number }> {
    const state = this.state;
    const scan = await scanVault(this.o.fs, filter, state.hashCache, this.o.crypto, this.limits);
    const view = await buildLocalView(scan, state.localMap, state.base, filter, this.o.fs);
    return { view, skipped: scan.skipped.size };
  }

  private async pullPhase(head: string, remote: Manifest, engine: EncryptionEngine, filter: SyncFilter, report: SyncReport): Promise<void> {
    const state = this.state;
    const { view, skipped } = await this.scanAndView(filter);
    report.skippedFiles = skipped;
    const plan = planPull(state.base, remote, view, filter, this.planContext());
    state.journal = {
      remoteCommit: head,
      remoteManifest: remote,
      ops: plan.ops,
      affectedIds: plan.affectedIds,
      conflicts: plan.conflicts,
    };
    if (plan.ops.length > 0) {
      // Write-ahead: the intent is durable before the first local file is touched.
      await this.o.store.persist();
    }
    await this.executeJournal(engine, false, report);
  }

  /** Runs the journal's ops and advances the base for every object whose ops all succeeded. */
  private async executeJournal(engine: EncryptionEngine, recovery: boolean, report: SyncReport): Promise<void> {
    const state = this.state;
    const journal = state.journal;
    if (!journal) return;
    const result = await applyLocalOps(journal.ops, {
      fs: this.o.fs,
      crypto: this.o.crypto,
      localMap: state.localMap,
      hashCache: state.hashCache,
      recovery,
      fetchContent: async (objectId, contentHash) => {
        const envelope = await this.o.remote.readObject(journal.remoteCommit, objectId);
        return engine.decryptObject(objectId, envelope, contentHash);
      },
    });

    for (let i = 0; i < journal.ops.length; i++) {
      const op = journal.ops[i];
      if (!op || result.failures.some((f) => f.index === i)) continue;
      if (op.op === "write") report.downloaded++;
      else if (op.op === "move") report.localMoves++;
      else if (op.op === "trash") report.localDeletes++;
    }
    report.failedLocalOps += result.failures.length;
    for (const failure of result.failures) {
      this.log.warn("local operation skipped", { index: failure.index, diverged: failure.reason === "diverged" });
    }

    for (const id of journal.affectedIds) {
      if (result.divergedIds.has(id)) continue;
      const entry = journal.remoteManifest.entries[id];
      if (entry) state.base[id] = entry;
      else delete state.base[id];
    }
    for (const conflict of journal.conflicts) {
      if (conflict.objectId && result.divergedIds.has(conflict.objectId)) continue;
      if (state.conflicts.some((c) => c.id === conflict.id)) continue;
      state.conflicts.push(conflict);
      report.newConflicts.push(conflict);
    }
    state.remote = journal.remoteManifest;
    state.lastRemoteCommit = journal.remoteCommit;
    state.lastManifestVersion = Math.max(state.lastManifestVersion, journal.remoteManifest.version);
    state.journal = null;
    await this.o.store.persist();
  }

  private async pushPhase(head: string, remote: Manifest, engine: EncryptionEngine, filter: SyncFilter, report: SyncReport): Promise<PushOutcome> {
    const state = this.state;
    const { view } = await this.scanAndView(filter);

    // Objects whose base could not advance (skipped local ops) are left for the next merge.
    const diverged = new Set<string>();
    for (const id of new Set([...Object.keys(state.base), ...Object.keys(remote.entries)])) {
      if (!entriesEquivalent(state.base[id], remote.entries[id])) diverged.add(id);
    }

    const ctx = this.planContext();
    const plan = planPush(state.base, remote, view, state.localMap, diverged, {
      maxFiles: this.limits.maxFilesPerCommit,
      maxBytes: this.limits.maxBytesPerCommit,
    }, ctx);
    report.nameCollisions.push(...plan.nameCollisions);
    if (plan.changeCount === 0) return "nothing";

    const entries = plan.entries;
    const changes: RemoteChange[] = [];
    let uploaded = 0;
    for (const upload of plan.uploads) {
      let data: Uint8Array;
      try {
        data = await this.o.fs.read(upload.path);
      } catch (error: unknown) {
        // Vanished since the scan: leave this object as it is remotely; the next sync picks it up.
        this.log.warn("file vanished before upload", { error: error instanceof Error });
        revertEntry(entries, remote, upload.objectId);
        continue;
      }
      if (data.length > this.limits.maxFileSize) {
        revertEntry(entries, remote, upload.objectId);
        continue;
      }
      const hash = await this.o.crypto.hash(data);
      const entry = entries[upload.objectId];
      if (isLive(entry) && (hash !== upload.expectedHash || data.length !== entry.size)) {
        entries[upload.objectId] = { ...entry, contentHash: hash, size: data.length, modified: this.now() };
      }
      changes.push({ kind: "putObject", objectId: upload.objectId, blob: await engine.encryptObject(upload.objectId, data) });
      uploaded++;
    }
    for (const id of plan.deletes) changes.push({ kind: "deleteObject", objectId: id });

    const manifest: Manifest = {
      type: MANIFEST_TYPE,
      formatVersion: 1,
      vaultId: state.vaultId as string,
      version: remote.version + 1,
      parentCommit: head,
      device: this.o.deviceId,
      updatedAt: this.now(),
      entries,
    };
    const encoded = encodeManifest(manifest);
    // Self-check: never publish a manifest our own strict parser would reject.
    decodeManifest(encoded, manifest.vaultId);
    changes.push({ kind: "putManifest", blob: await engine.encryptManifest(encoded) });

    const commit = await this.o.remote.createCommit(head, changes, {
      message: buildCommitMessage(plan.changeCount, this.o.deviceId),
    });
    state.pendingCommit = { commit, parent: head, manifest };
    await this.o.store.persist();

    try {
      await this.o.remote.updateHead(head, commit);
    } catch (error: unknown) {
      if (error instanceof SyncError && error.code === "ConcurrentRemoteUpdate") {
        state.pendingCommit = null;
        await this.o.store.persist();
        return "concurrent";
      }
      // Unknown outcome (e.g. network): pendingCommit stays and is resolved on the next run.
      throw error;
    }

    this.finalizeCommit(commit, manifest);
    await this.o.store.persist();
    report.commits.push(commit);
    report.uploaded += uploaded;
    report.remoteDeletes += plan.deletes.length;
    this.log.info("pushed commit", { uploads: uploaded, deletes: plan.deletes.length });
    return plan.morePending ? "more" : "done";
  }

  /**
   * Records a commit that is now the branch head. The base advances for all objects except those whose
   * base intentionally lags behind the remote (skipped local ops → conflict on the next merge).
   */
  private finalizeCommit(commit: string, manifest: Manifest): void {
    const state = this.state;
    const previousRemote = state.remote?.entries ?? {};
    const nextBase: Record<string, ManifestEntry> = {};
    for (const [id, entry] of Object.entries(manifest.entries)) {
      const lagging = !entriesEquivalent(state.base[id], previousRemote[id]);
      if (!lagging) nextBase[id] = entry;
      else if (state.base[id] !== undefined) nextBase[id] = state.base[id] as ManifestEntry;
      // lagging with no base (remote create not yet applied locally) stays without base
    }
    state.base = nextBase;
    state.remote = manifest;
    state.lastRemoteCommit = commit;
    state.lastManifestVersion = manifest.version;
    state.pendingCommit = null;
  }
}

function revertEntry(entries: Record<string, ManifestEntry>, remote: Manifest, objectId: string): void {
  const previous = remote.entries[objectId];
  if (previous) entries[objectId] = previous;
  else delete entries[objectId];
}
