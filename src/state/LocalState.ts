import type { Manifest, ManifestEntry } from "../manifest/Manifest";
import { parseBackendLocation, type BackendLocation } from "../remote/BackendLocation";
import { parseManifestEntries, parseManifestObject } from "../manifest/ManifestCodec";
import {
  expectArray,
  expectInteger,
  expectLiteral,
  expectRecord,
  expectString,
  GIT_SHA,
  HEX_32,
  HEX_64,
  isRecord,
  optionalString,
  ValidationError,
} from "../util/validate";
import { isValidVaultPath } from "../vault/PathUtils";
import type { HashCacheEntry } from "../vault/VaultScanner";

/**
 * Per-device synchronisation state. Stored in the plugin folder (never synchronised) and contains no
 * secrets. It is only advanced after the remote branch actually points at the corresponding commit.
 */

export type ConflictKind =
  /** Both sides changed the content. */
  | "content"
  /** Deleted locally, modified remotely → remote version restored. */
  | "localDeleteRemoteModify"
  /** Modified locally, deleted remotely → local version kept and re-uploaded. */
  | "localModifyRemoteDelete"
  /** Different files were created at the same path on two devices. */
  | "bothCreated";

export interface ConflictRecord {
  readonly id: string;
  readonly kind: ConflictKind;
  /** Path of the canonical (remote) version. */
  readonly path: string;
  /** Path where the other version was preserved, if a copy was created. */
  readonly conflictPath: string | null;
  readonly detectedAt: number;
  /** Object id the conflict belongs to (internal bookkeeping). */
  readonly objectId: string | null;
}

export type LocalOp =
  | {
      readonly op: "move";
      readonly from: string;
      readonly to: string;
      /** Object id tracked at `from` (null for untracked files). */
      readonly objectId: string | null;
      /** Object id the file is tracked as after the move (conflict copies get a fresh id). */
      readonly resultObjectId: string | null;
      readonly requires: readonly number[];
    }
  | {
      readonly op: "write";
      readonly path: string;
      readonly objectId: string;
      readonly contentHash: string;
      readonly size: number;
      /** Hash the file must currently have (replace), or null if the path must not exist (create). */
      readonly expectedCurrentHash: string | null;
      readonly requires: readonly number[];
    }
  | {
      readonly op: "trash";
      readonly path: string;
      readonly objectId: string;
      readonly expectedHash: string;
      readonly requires: readonly number[];
    }
  | {
      /** Identity merge: an untracked local file already has the incoming content. */
      readonly op: "adopt";
      readonly path: string;
      readonly objectId: string;
      readonly expectedHash: string;
      /** Id the file was tracked as before; its base must not advance if the adopt fails. */
      readonly replacesObjectId: string | null;
      readonly requires: readonly number[];
    }
  | {
      /** Forget a local deletion that must not be pushed (the file is gone and stays gone). */
      readonly op: "untrack";
      readonly objectId: string;
      readonly requires: readonly number[];
    };

/** Write-ahead intent log for applying remote changes locally (crash recovery). */
export interface ApplyJournal {
  readonly remoteCommit: string;
  readonly remoteManifest: Manifest;
  readonly ops: readonly LocalOp[];
  /** Ids whose base becomes the remote entry if none of their ops diverged. */
  readonly affectedIds: readonly string[];
  /** Conflicts to record once the ops of their object succeeded. */
  readonly conflicts: readonly ConflictRecord[];
}

/** Commit created and about to become (or already became) the branch head. */
export interface PendingCommit {
  readonly commit: string;
  readonly parent: string;
  readonly manifest: Manifest;
}

export interface PendingSwitch {
  readonly location: BackendLocation;
  readonly commit: string;
  readonly manifest: Manifest;
}

/** The announced new location plus the commit of the old repository that carries the marker. */
export type MovedTo = BackendLocation & { readonly markerCommit: string };

export interface LocalState {
  readonly stateVersion: 1;
  readonly deviceId: string;
  vaultId: string | null;
  lastRemoteCommit: string | null;
  lastManifestVersion: number;
  lastSyncTime: number | null;
  /** Manifest at lastRemoteCommit. */
  remote: Manifest | null;
  /** Merge base per object id (normally equal to `remote.entries`). */
  base: Record<string, ManifestEntry>;
  /** Tracked local files: vault path → object id. Updated live by rename events. */
  localMap: Record<string, string>;
  hashCache: Record<string, HashCacheEntry>;
  journal: ApplyJournal | null;
  pendingCommit: PendingCommit | null;
  conflicts: ConflictRecord[];
  /** Set when the remote announced that the vault moved (see SyncError "VaultMoved"). */
  movedTo: MovedTo | null;
  /**
   * A verified head of a new repository this device is switching to (vault moved). Recorded before the
   * settings change and applied afterwards, so an interruption never leaves state and settings apart.
   */
  pendingSwitch: PendingSwitch | null;
}

export function newLocalState(deviceId: string): LocalState {
  return {
    stateVersion: 1,
    deviceId,
    vaultId: null,
    lastRemoteCommit: null,
    lastManifestVersion: 0,
    lastSyncTime: null,
    remote: null,
    base: {},
    localMap: {},
    hashCache: {},
    journal: null,
    pendingCommit: null,
    conflicts: [],
    movedTo: null,
    pendingSwitch: null,
  };
}

/** Validates a parsed state object. Throws ValidationError; callers treat invalid state as absent. */
export function parseLocalState(raw: unknown): LocalState {
  const r = expectRecord(raw, "state");
  expectLiteral(r.stateVersion, 1, "state.stateVersion");
  const vaultId = optionalString(r.vaultId, "state.vaultId", HEX_32);
  const remote = r.remote === null || r.remote === undefined ? null : parseManifestObject(r.remote, vaultId ?? "");
  const localMap: Record<string, string> = {};
  for (const [path, id] of Object.entries(expectRecord(r.localMap, "state.localMap"))) {
    if (!isValidVaultPath(path)) throw new ValidationError("state.localMap", "invalid path");
    localMap[path] = expectString(id, "state.localMap[]", HEX_32);
  }
  const hashCache: Record<string, HashCacheEntry> = {};
  for (const [path, entry] of Object.entries(expectRecord(r.hashCache, "state.hashCache"))) {
    const e = expectRecord(entry, "state.hashCache[]");
    hashCache[path] = {
      size: expectInteger(e.size, "hashCache.size", 0),
      mtime: expectInteger(e.mtime, "hashCache.mtime"),
      hash: expectString(e.hash, "hashCache.hash", HEX_64),
    };
  }
  let pendingCommit: PendingCommit | null = null;
  if (isRecord(r.pendingCommit)) {
    pendingCommit = {
      commit: expectString(r.pendingCommit.commit, "pendingCommit.commit", GIT_SHA),
      parent: expectString(r.pendingCommit.parent, "pendingCommit.parent", GIT_SHA),
      manifest: parseManifestObject(r.pendingCommit.manifest, vaultId ?? ""),
    };
  }
  let journal: ApplyJournal | null = null;
  if (isRecord(r.journal)) {
    journal = {
      remoteCommit: expectString(r.journal.remoteCommit, "journal.remoteCommit", GIT_SHA),
      remoteManifest: parseManifestObject(r.journal.remoteManifest, vaultId ?? ""),
      ops: expectArray(r.journal.ops, "journal.ops").map((op) => parseOp(op)),
      affectedIds: expectArray(r.journal.affectedIds, "journal.affectedIds").map((id) => expectString(id, "journal.affectedIds[]", HEX_32)),
      conflicts: expectArray(r.journal.conflicts, "journal.conflicts").map((c) => parseConflict(c)),
    };
  }
  return {
    stateVersion: 1,
    deviceId: expectString(r.deviceId, "state.deviceId"),
    vaultId,
    lastRemoteCommit: optionalString(r.lastRemoteCommit, "state.lastRemoteCommit", GIT_SHA),
    lastManifestVersion: expectInteger(r.lastManifestVersion, "state.lastManifestVersion", 0),
    lastSyncTime: r.lastSyncTime === null ? null : expectInteger(r.lastSyncTime, "state.lastSyncTime", 0),
    remote,
    base: parseManifestEntries(r.base, "state.base"),
    localMap,
    hashCache,
    journal,
    pendingCommit,
    conflicts: expectArray(r.conflicts, "state.conflicts").map((c) => parseConflict(c)),
    movedTo: isRecord(r.movedTo) ? parseMovedTo(r.movedTo) : null,
    pendingSwitch: isRecord(r.pendingSwitch)
      ? {
          location: parseBackendLocation(r.pendingSwitch.location, "state.pendingSwitch.location", true),
          commit: expectString(r.pendingSwitch.commit, "state.pendingSwitch.commit", GIT_SHA),
          manifest: parseManifestObject(r.pendingSwitch.manifest, vaultId ?? ""),
        }
      : null,
  };
}

const CONFLICT_KINDS: readonly ConflictKind[] = ["content", "localDeleteRemoteModify", "localModifyRemoteDelete", "bothCreated"];

function parseConflict(raw: unknown): ConflictRecord {
  const c = expectRecord(raw, "conflict");
  const kind = expectString(c.kind, "conflict.kind") as ConflictKind;
  if (!CONFLICT_KINDS.includes(kind)) throw new ValidationError("conflict.kind", "unknown");
  return {
    id: expectString(c.id, "conflict.id"),
    kind,
    path: expectString(c.path, "conflict.path"),
    conflictPath: optionalString(c.conflictPath, "conflict.conflictPath"),
    detectedAt: expectInteger(c.detectedAt, "conflict.detectedAt", 0),
    objectId: optionalString(c.objectId, "conflict.objectId", HEX_32),
  };
}

function parseRequires(raw: unknown): number[] {
  return expectArray(raw, "op.requires").map((n) => expectInteger(n, "op.requires[]", 0));
}

function parseOp(raw: unknown): LocalOp {
  const o = expectRecord(raw, "op");
  const kind = expectString(o.op, "op.op");
  const path = (v: unknown, f: string): string => {
    const p = expectString(v, f);
    if (!isValidVaultPath(p)) throw new ValidationError(f, "invalid path");
    return p;
  };
  switch (kind) {
    case "move":
      return {
        op: "move",
        from: path(o.from, "op.from"),
        to: path(o.to, "op.to"),
        objectId: optionalString(o.objectId, "op.objectId", HEX_32),
        resultObjectId: optionalString(o.resultObjectId, "op.resultObjectId", HEX_32),
        requires: parseRequires(o.requires),
      };
    case "write":
      return {
        op: "write",
        path: path(o.path, "op.path"),
        objectId: expectString(o.objectId, "op.objectId", HEX_32),
        contentHash: expectString(o.contentHash, "op.contentHash", HEX_64),
        size: expectInteger(o.size, "op.size", 0),
        expectedCurrentHash: optionalString(o.expectedCurrentHash, "op.expectedCurrentHash", HEX_64),
        requires: parseRequires(o.requires),
      };
    case "trash":
      return {
        op: "trash",
        path: path(o.path, "op.path"),
        objectId: expectString(o.objectId, "op.objectId", HEX_32),
        expectedHash: expectString(o.expectedHash, "op.expectedHash", HEX_64),
        requires: parseRequires(o.requires),
      };
    case "adopt":
      return {
        op: "adopt",
        path: path(o.path, "op.path"),
        objectId: expectString(o.objectId, "op.objectId", HEX_32),
        expectedHash: expectString(o.expectedHash, "op.expectedHash", HEX_64),
        replacesObjectId: optionalString(o.replacesObjectId, "op.replacesObjectId", HEX_32),
        requires: parseRequires(o.requires),
      };
    case "untrack":
      return { op: "untrack", objectId: expectString(o.objectId, "op.objectId", HEX_32), requires: parseRequires(o.requires) };
    default:
      throw new ValidationError("op.op", "unknown op");
  }
}

function parseMovedTo(raw: Record<string, unknown>): MovedTo {
  const { markerCommit, ...location } = raw;
  return { ...parseBackendLocation(location, "state.movedTo", true), markerCommit: expectString(markerCommit, "state.movedTo.markerCommit", GIT_SHA) };
}
