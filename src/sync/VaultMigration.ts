import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { CryptoError } from "../errors/CryptoError";
import { GitHubError } from "../errors/GitHubError";
import { SyncError } from "../errors/SyncError";
import {

  isLive,
  MANIFEST_TYPE,
  MANIFEST_FORMAT_VERSION,
  type ArchivedRepo,
  type Manifest,
  type ManifestEntry,
  type RepoLocation,
} from "../manifest/Manifest";
import { decodeManifest, encodeManifest } from "../manifest/ManifestCodec";
import { buildMigrationMessage, buildMovedMessage } from "../remote/RemoteLayout";
import type { RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import type { LocalState } from "../state/LocalState";
import type { SyncStateStore } from "../state/SyncStateStore";
import { toHex } from "../util/bytes";
import { DEFAULT_CHUNK_SIZE, encodeObject, readChunkIndex, readObjectContent, withChunks, type ChunkRef } from "./ChunkedContent";
import { configHashOf, readVerifiedHead, type VerifiedHead } from "./HistoryReader";
import { serializeVaultConfig } from "../manifest/VaultConfig";
import { bytesEqual } from "../util/bytes";
import { DEFAULT_LIMITS, HARD_MAX_FILE_SIZE } from "./SyncEngine";
import { inspectRemote } from "./VaultSetup";

/**
 * Moving a vault to a fresh repository (docs/DESIGN.md §7c). The git history of a vault only grows; the only
 * way to shrink it without deleting anything is to continue in a new repository that starts with the current
 * state. The old repository stays untouched except for one final, authenticated "moved" marker and remains
 * readable as an archive (version history, deleted files).
 *
 * Every file is downloaded, fully verified, re-encrypted with a fresh nonce under the SAME object id (so the
 * archive's history of an id continues seamlessly) and committed in batches. The copy is resumable: an
 * interrupted move continues from what the new repository already contains.
 */

export interface MoveOptions {
  readonly crypto: CryptoProvider;
  readonly keys: VaultKeys;
  readonly store: SyncStateStore;
  readonly deviceId: string;
  readonly source: RemoteRepository;
  readonly sourceLocation: RepoLocation;
  readonly target: RemoteRepository;
  readonly targetLocation: RepoLocation;
  readonly limits?: { readonly maxFilesPerCommit?: number; readonly maxBytesPerCommit?: number; readonly chunkSize?: number };
  readonly onProgress?: (done: number, total: number) => void;
  readonly now?: () => number;
}

export interface MoveResult {
  readonly targetCommit: string;
  readonly markerCommit: string;
  /** Files copied in this run (a resumed move copies only what is missing). */
  readonly copied: number;
}

/**
 * Must run under the SyncMutex right after a successful sync: the source head must be the last synchronised
 * commit, so this device's merge base stays valid for the new repository.
 */
export async function moveVault(o: MoveOptions): Promise<MoveResult> {
  const state = o.store.state;
  if (!state.vaultId || o.keys.vaultId !== state.vaultId) throw SyncError.blocked("ForeignVault");
  if (state.journal || state.pendingCommit) throw new SyncError("InvalidState", "an interrupted synchronisation must finish first");
  if (sameLocation(o.sourceLocation, o.targetLocation)) throw new SyncError("InvalidState", "the new repository must differ from the current one");

  const source = await readVerifiedHead(o.source, o.crypto, o.keys, o.deviceId);
  if (source.manifest.movedTo) throw SyncError.blocked("VaultMoved");
  if (source.commit !== state.lastRemoteCommit) throw new SyncError("InvalidState", "synchronise first: the repository changed since the last sync");

  const inspection = await inspectRemote(o.target);
  if (inspection.kind === "foreign") throw SyncError.blocked("RepositoryNotEmpty");
  if (inspection.kind === "uninitialized") {
    // Same public config: same vault id, key slots and MAC – password and recovery key keep working.
    await o.target.initialize(source.config, { message: `Initialize encrypted vault (moved)\n\nDevice: ${o.deviceId}\n` });
  } else if (inspection.config.vaultId !== state.vaultId) {
    throw SyncError.blocked("ForeignVault");
  }
  const target = await readVerifiedHead(o.target, o.crypto, o.keys, o.deviceId);
  if (target.manifest.movedTo) throw new SyncError("InvalidState", "the new repository was itself retired");

  const archive: ArchivedRepo = { ...o.sourceLocation, commit: source.commit };
  const movedFrom = [archive, ...(source.manifest.movedFrom ?? []).filter((a) => !sameLocation(a, archive))];
  const mirrored = await mirror(o, source, target, movedFrom);

  // Terminal marker in the old repository (compare-and-swap: fails if another device pushed meanwhile; the
  // move can then simply be repeated after a sync and continues where it stopped).
  const marker: Manifest = {
    ...source.manifest,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version: source.manifest.version + 1,
    parentCommit: source.commit,
    device: o.deviceId,
    updatedAt: (o.now ?? Date.now)(),
    movedTo: o.targetLocation,
    configHash: source.configHash,
  };
  const engine = new EncryptionEngine(o.crypto, o.keys);
  const markerCommit = await o.source.createCommit(source.commit, [{ kind: "putManifest", blob: await engine.encryptManifest(checkedManifest(marker)) }], {
    message: buildMovedMessage(o.deviceId),
  });
  await o.source.updateHead(source.commit, markerCommit);

  // The caller switches the settings and then calls completeSwitch (both survive an interruption).
  recordSwitch(state, o.targetLocation, mirrored.head);
  await o.store.persist();
  return { targetCommit: mirrored.head.commit, markerCommit, copied: mirrored.copied };
}

/**
 * Prepares switching a device whose repository announced a move (state.movedTo) to the new repository. The
 * merge base stays: the new repository holds the same object ids with the same contents, so the next sync
 * merges exactly as it would have with the old one. Nothing local is touched. The caller switches the
 * settings to `state.pendingSwitch.location` and then calls completeSwitch.
 */
export async function followMove(o: {
  crypto: CryptoProvider;
  keys: VaultKeys;
  store: SyncStateStore;
  deviceId: string;
  /** Repository this device synchronised with so far (the one that carries the marker). */
  sourceLocation: RepoLocation;
  target: RemoteRepository;
}): Promise<void> {
  const state = o.store.state;
  const moved = state.movedTo;
  if (!moved) throw new SyncError("InvalidState", "the vault did not move");
  if (!state.vaultId || o.keys.vaultId !== state.vaultId) throw SyncError.blocked("ForeignVault");
  if (state.journal || state.pendingCommit) throw new SyncError("InvalidState", "an interrupted synchronisation must finish first");
  const head = await readVerifiedHead(o.target, o.crypto, o.keys, o.deviceId);
  // The new repository must name the old one as its predecessor (it was created by the move).
  if (!(head.manifest.movedFrom ?? []).some((a) => sameLocation(a, o.sourceLocation))) throw new SyncError("InvalidState", "the new repository does not continue this vault");
  if (head.manifest.version <= state.lastManifestVersion) throw SyncError.blocked("HistoryRewritten");
  recordSwitch(state, { owner: moved.owner, repo: moved.repo, branch: moved.branch }, head);
  await o.store.persist();
}

function recordSwitch(state: LocalState, location: RepoLocation, head: VerifiedHead): void {
  state.pendingSwitch = { location, commit: head.commit, manifest: head.manifest };
}

/**
 * Applies a recorded switch once the settings point at the new repository. If the new repository has itself
 * moved on (A → B → C), the next hop is announced right away, so the device never writes into an archive.
 */
export function completeSwitch(state: LocalState): void {
  const pending = state.pendingSwitch;
  if (!pending) return;
  state.lastRemoteCommit = pending.commit;
  state.remote = pending.manifest;
  state.lastManifestVersion = pending.manifest.version;
  state.pendingCommit = null;
  state.movedTo = pending.manifest.movedTo ? { ...pending.manifest.movedTo, markerCommit: pending.commit } : null;
  state.pendingSwitch = null;
}

export function sameLocation(a: RepoLocation, b: RepoLocation): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.branch === b.branch;
}

async function mirror(o: MoveOptions, source: VerifiedHead, target: VerifiedHead, movedFrom: ArchivedRepo[]): Promise<{ head: VerifiedHead; copied: number }> {
  const engine = new EncryptionEngine(o.crypto, o.keys);
  const maxFiles = o.limits?.maxFilesPerCommit ?? DEFAULT_LIMITS.maxFilesPerCommit;
  const maxBytes = o.limits?.maxBytesPerCommit ?? DEFAULT_LIMITS.maxBytesPerCommit;
  const chunking = { remote: o.target, engine, chunkSize: o.limits?.chunkSize ?? DEFAULT_CHUNK_SIZE, newChunkId: () => toHex(o.crypto.randomBytes(16)) };
  const want = source.manifest.entries;
  const have = target.manifest.entries;
  const oldChunks = async (id: string): Promise<ChunkRef[] | null> => {
    const entry = have[id];
    return isLive(entry) && entry.chunks !== undefined ? readChunkIndex(o.target, engine, target.commit, id) : null;
  };

  // Every intermediate manifest is a subset of the final one (no path collisions): final entries whose object
  // is already in place, all tombstones, and the files copied so far.
  const entries: Record<string, ManifestEntry> = {};
  const toCopy: string[] = [];
  for (const [id, w] of Object.entries(want)) {
    if (!isLive(w)) entries[id] = w;
    else {
      const h = have[id];
      if (isLive(h) && h.contentHash === w.contentHash && h.size === w.size) entries[id] = withChunks(w, h.chunks);
      else toCopy.push(id);
    }
  }

  let changes: RemoteChange[] = [];
  // The new repository carries the source's current config (a resumed move after a password change).
  // Hash of the config as written into the new repository (bootstrap or putConfig below serialise it).
  const configHash = await configHashOf(o.crypto, source.config);
  if (!bytesEqual(serializeVaultConfig(source.config), serializeVaultConfig(target.config))) changes.push({ kind: "putConfig", config: source.config });
  // A resumed move trusts nothing in the target: objects it claims to have are re-verified before reuse.
  for (const [id, w] of Object.entries(entries)) {
    if (!isLive(w)) continue;
    try {
      (await readObjectContent(o.target, engine, target.commit, id, w.contentHash, Math.min(w.size, HARD_MAX_FILE_SIZE))).fill(0);
    } catch (error: unknown) {
      if (!(error instanceof GitHubError && error.category === "NotFound") && !(error instanceof CryptoError)) throw error;
      delete entries[id];
      toCopy.push(id);
    }
  }
  toCopy.sort((a, b) => ((want[a] as { path: string }).path < (want[b] as { path: string }).path ? -1 : 1));
  for (const [id, h] of Object.entries(have)) {
    if (!isLive(h) || isLive(want[id])) continue;
    changes.push({ kind: "deleteObject", objectId: id });
    for (const chunk of (await oldChunks(id)) ?? []) changes.push({ kind: "deleteObject", objectId: chunk.id });
  }

  let head = target;
  let version = Math.max(target.manifest.version, source.manifest.version + 1);
  let batchFiles = 0;
  let batchBytes = 0;
  let copied = 0;
  const commit = async (final: boolean): Promise<void> => {
    const manifest: Manifest = {
      type: MANIFEST_TYPE,
      formatVersion: MANIFEST_FORMAT_VERSION,
      vaultId: o.keys.vaultId,
      version: ++version,
      parentCommit: head.commit,
      device: o.deviceId,
      updatedAt: (o.now ?? Date.now)(),
      entries: { ...entries },
      ...(final ? { movedFrom } : {}),
      configHash,
    };
    const all: RemoteChange[] = [...changes, { kind: "putManifest", blob: await engine.encryptManifest(checkedManifest(manifest)) }];
    const created = await o.target.createCommit(head.commit, all, { message: buildMigrationMessage(Math.max(1, changes.length), o.deviceId) });
    await o.target.updateHead(head.commit, created);
    head = { commit: created, config: source.config, configHash, manifest };
    changes = [];
    batchFiles = 0;
    batchBytes = 0;
  };

  o.onProgress?.(0, toCopy.length);
  for (const id of toCopy) {
    const w = want[id];
    if (!isLive(w)) continue;
    const content = await readObjectContent(o.source, engine, source.commit, id, w.contentHash, Math.min(w.size, HARD_MAX_FILE_SIZE));
    const encoded = await encodeObject(chunking, id, content, await oldChunks(id));
    content.fill(0);
    changes.push(...encoded.changes);
    entries[id] = withChunks(w, encoded.chunks);
    copied++;
    batchFiles++;
    batchBytes += w.size;
    o.onProgress?.(copied, toCopy.length);
    if (batchFiles >= maxFiles || batchBytes >= maxBytes) await commit(false);
  }
  await commit(true);
  return { head, copied };
}

/** Self-check: never publish a manifest our own strict parser would reject. */
function checkedManifest(manifest: Manifest): Uint8Array {
  const encoded = encodeManifest(manifest);
  decodeManifest(encoded, manifest.vaultId);
  return encoded;
}

