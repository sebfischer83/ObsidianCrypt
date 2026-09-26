import { entriesEquivalent, isLive, type LiveEntry, type Manifest, type ManifestEntry } from "../manifest/Manifest";
import type { ConflictKind, ConflictRecord, LocalOp } from "../state/LocalState";
import { pathKey } from "../vault/PathUtils";
import type { SyncFilter } from "../vault/SyncFilter";
import type { LocalView } from "./ChangeDetector";
import { conflictPath, PathOccupancy, temporaryMovePath } from "./ConflictNaming";

/**
 * Deterministic three-way merge (base / local / remote) per stable object id. See docs/DESIGN.md §6.
 *
 * Phase 1 ("pull plan") computes the local operations needed to incorporate remote changes, including
 * conflict handling. It never overwrites or deletes local content that differs from the base: such
 * content is either kept in place or moved (renamed, content untouched) to a conflict copy first.
 *
 * Phase 2 ("push plan") runs after phase 1 was applied; at that point base == remote for every object
 * that was not skipped, so the local diff against base is exactly what must be uploaded.
 */

export interface PlanContext {
  readonly deviceId: string;
  readonly now: number;
  readonly newObjectId: () => string;
  readonly randomToken: () => string;
  /** Remote files larger than this are not materialised on this device (and never treated as deleted). */
  readonly maxFileSize: number;
}

export interface PullPlan {
  readonly ops: LocalOp[];
  /** Ids whose base becomes the remote entry once their ops succeeded. */
  readonly affectedIds: string[];
  readonly conflicts: ConflictRecord[];
}

interface Occupant {
  readonly id: string | null;
  readonly hash: string | null;
}

interface WriteIntent {
  readonly id: string;
  readonly entry: LiveEntry;
  readonly path: string;
  readonly expected: string | null;
}

interface MoveIntent {
  readonly id: string;
  from: string;
  readonly to: string;
}

export function planPull(
  base: Readonly<Record<string, ManifestEntry>>,
  remote: Manifest,
  view: LocalView,
  filter: SyncFilter,
  ctx: PlanContext,
): PullPlan {
  const occ = new PathOccupancy<Occupant>();
  for (const [id, file] of view.present) occ.set(file.path, { id, hash: file.hash });
  for (const [path, file] of view.untracked) occ.set(path, { id: null, hash: file.hash });
  for (const path of view.skipped.keys()) if (!occ.has(path)) occ.set(path, { id: null, hash: null });

  const remotePathKeys = new Set<string>();
  for (const entry of Object.values(remote.entries)) if (isLive(entry)) remotePathKeys.add(pathKey(entry.path));
  const isTaken = (candidate: string): boolean => occ.has(candidate) || remotePathKeys.has(pathKey(candidate));

  const ops: LocalOp[] = [];
  const lastOpAt = new Map<string, number>();
  const addOp = (op: DistributiveOmit<LocalOp, "requires">, paths: string[]): void => {
    const requires = new Set<number>();
    for (const p of paths) {
      const prev = lastOpAt.get(pathKey(p));
      if (prev !== undefined) requires.add(prev);
    }
    const index = ops.length;
    ops.push({ ...op, requires: [...requires].sort((a, b) => a - b) } as LocalOp);
    for (const p of paths) lastOpAt.set(pathKey(p), index);
  };

  const affected: string[] = [];
  const conflicts: ConflictRecord[] = [];
  const conflict = (kind: ConflictKind, objectId: string | null, path: string, copy: string | null): ConflictRecord => {
    const record: ConflictRecord = { id: `${ctx.now}-${conflicts.length}-${ctx.randomToken()}`, kind, path, conflictPath: copy, detectedAt: ctx.now, objectId };
    conflicts.push(record);
    return record;
  };

  const trashes: Array<{ id: string; path: string; hash: string }> = [];
  const moves: MoveIntent[] = [];
  const writes: WriteIntent[] = [];
  const conflictCopies: Array<{ id: string; from: string; hash: string; newId: string; record: number }> = [];
  const rekeys: Array<{ id: string; path: string; hash: string; newId: string }> = [];
  const untracks: string[] = [];

  const ids = new Set<string>([...Object.keys(base), ...Object.keys(remote.entries)]);
  for (const id of [...ids].sort()) {
    const b = base[id];
    const r = remote.entries[id];
    const rLive = isLive(r);
    const rManaged = rLive && r.size <= ctx.maxFileSize && filter.includes(r.path) && !view.skipped.has(r.path);
    if (entriesEquivalent(b, r)) {
      // Unchanged remotely but never materialised here (e.g. lost state): restore, never delete.
      if (view.absent.has(id) && rManaged) {
        affected.push(id);
        writes.push({ id, entry: r, path: r.path, expected: null });
      }
      continue;
    }
    // The file exists here but is not managed right now (too large, unreadable, stale index): its local
    // content is unknown to the merge, so the base must stay where it is until it is managed again.
    if (view.heldBack.has(id)) continue;
    affected.push(id);
    const local = view.present.get(id);

    if (view.unmanaged.has(id)) {
      // Excluded here and not present locally: nothing local can be lost; materialise if now managed.
      if (rManaged && !local) writes.push({ id, entry: r, path: r.path, expected: null });
      continue;
    }

    if (local) {
      const bLive = isLive(b);
      const localChanged = !(bLive && b.path === local.path && b.contentHash === local.hash);
      if (!rLive) {
        if (!localChanged) trashes.push({ id, path: local.path, hash: local.hash });
        // Modified (or moved) locally but deleted remotely: keep it; phase 2 re-uploads it as a new object.
        else conflict("localModifyRemoteDelete", id, local.path, null);
        continue;
      }
      if (!rManaged) {
        // Remote moved the file to a location this device does not synchronise.
        if (!localChanged) trashes.push({ id, path: local.path, hash: local.hash });
        else {
          rekeys.push({ id, path: local.path, hash: local.hash, newId: ctx.newObjectId() });
          conflict("localModifyRemoteDelete", id, local.path, null);
        }
        continue;
      }
      if (!localChanged) {
        if (local.path !== r.path) moves.push({ id, from: local.path, to: r.path });
        if (local.hash !== r.contentHash) writes.push({ id, entry: r, path: r.path, expected: local.hash });
        continue;
      }
      const contentLocal = !bLive || local.hash !== b.contentHash;
      const contentRemote = !bLive || r.contentHash !== b.contentHash;
      if (contentLocal && contentRemote && local.hash !== r.contentHash) {
        // Content conflict: remote keeps the canonical path, local version is preserved as a copy.
        conflict("content", id, r.path, null);
        conflictCopies.push({ id, from: local.path, hash: local.hash, newId: ctx.newObjectId(), record: conflicts.length - 1 });
        writes.push({ id, entry: r, path: r.path, expected: null });
        continue;
      }
      const remoteMoved = !bLive || r.path !== b.path;
      const finalPath = remoteMoved ? r.path : local.path;
      if (finalPath !== local.path) moves.push({ id, from: local.path, to: finalPath });
      if (contentRemote && !contentLocal && local.hash !== r.contentHash) {
        writes.push({ id, entry: r, path: finalPath, expected: local.hash });
      }
      continue;
    }

    if (view.deleted.has(id)) {
      if (rLive) {
        // Deleted locally but changed remotely: the modification wins over the deletion. If this device can
        // materialise it, restore it; otherwise stop tracking the deletion so it is never pushed.
        conflict("localDeleteRemoteModify", id, r.path, null);
        if (rManaged) writes.push({ id, entry: r, path: r.path, expected: null });
        else untracks.push(id);
      }
      continue;
    }

    // Not present locally at all (new remote file or never materialised here).
    if (rManaged) writes.push({ id, entry: r, path: r.path, expected: null });
  }

  const preserveOccupant = (occupantPath: string, occupant: Occupant, claimedPath: string): void => {
    const copy = conflictPath(occupantPath, ctx.now, ctx.deviceId, isTaken);
    addOp({ op: "move", from: occupantPath, to: copy, objectId: occupant.id, resultObjectId: occupant.id }, [occupantPath, copy]);
    occ.delete(occupantPath);
    occ.set(copy, occupant);
    conflict("bothCreated", occupant.id, claimedPath, copy);
  };

  // 1. Preserve local versions of content conflicts (pure renames, content untouched).
  for (const c of conflictCopies) {
    const copy = conflictPath(c.from, ctx.now, ctx.deviceId, isTaken);
    addOp({ op: "move", from: c.from, to: copy, objectId: c.id, resultObjectId: c.newId }, [c.from, copy]);
    occ.delete(c.from);
    occ.set(copy, { id: c.newId, hash: c.hash });
    const record = conflicts[c.record] as ConflictRecord;
    conflicts[c.record] = { ...record, conflictPath: copy };
  }
  for (const k of rekeys) {
    addOp({ op: "adopt", path: k.path, objectId: k.newId, expectedHash: k.hash, replacesObjectId: k.id }, [k.path]);
    occ.set(k.path, { id: k.newId, hash: k.hash });
  }

  for (const id of untracks) addOp({ op: "untrack", objectId: id }, []);

  // 2. Deletions (to the trash, only if content still equals the base).
  for (const t of trashes) {
    addOp({ op: "trash", path: t.path, objectId: t.id, expectedHash: t.hash }, [t.path]);
    occ.delete(t.path);
  }

  // 3. Moves, resolving chains and cycles.
  let pending = [...moves];
  let guard = 0;
  while (pending.length > 0 && guard++ < 10000) {
    let progress = false;
    for (const m of [...pending]) {
      const occupant = occ.get(m.to);
      const moverIds = new Set(pending.map((p) => p.id));
      if (occupant && occupant.value.id !== m.id) {
        if (occupant.value.id !== null && moverIds.has(occupant.value.id)) continue; // wait for it to move away
        preserveOccupant(occupant.path, occupant.value, m.to);
      }
      const self = occ.get(m.from);
      addOp({ op: "move", from: m.from, to: m.to, objectId: m.id, resultObjectId: m.id }, [m.from, m.to]);
      occ.delete(m.from);
      occ.set(m.to, self?.value ?? { id: m.id, hash: null });
      pending = pending.filter((p) => p !== m);
      progress = true;
    }
    if (!progress && pending.length > 0) {
      // Cycle (e.g. A↔B): park one file under a visible temporary name.
      const m = pending[0] as MoveIntent;
      const tmp = temporaryMovePath(m.from, ctx.randomToken(), isTaken);
      const self = occ.get(m.from);
      addOp({ op: "move", from: m.from, to: tmp, objectId: m.id, resultObjectId: m.id }, [m.from, tmp]);
      occ.delete(m.from);
      occ.set(tmp, self?.value ?? { id: m.id, hash: null });
      m.from = tmp;
    }
  }

  // 4. Writes (downloads), handling collisions with local files at the target path.
  for (const w of writes) {
    const occupant = occ.get(w.path);
    let expected = w.expected;
    if (occupant && occupant.value.id !== w.id) {
      const occupantIsNewLocal = occupant.value.id === null || !isLive(base[occupant.value.id]);
      if (occupantIsNewLocal && occupant.value.hash === w.entry.contentHash) {
        // Identical file created independently on both sides: merge identities, no copy.
        addOp({ op: "adopt", path: occupant.path, objectId: w.id, expectedHash: w.entry.contentHash, replacesObjectId: occupant.value.id }, [occupant.path]);
        occ.set(occupant.path, { id: w.id, hash: w.entry.contentHash });
        continue;
      }
      preserveOccupant(occupant.path, occupant.value, w.path);
      expected = null;
    } else if (!occupant) {
      expected = null;
    }
    addOp(
      { op: "write", path: w.path, objectId: w.id, contentHash: w.entry.contentHash, size: w.entry.size, expectedCurrentHash: expected },
      [w.path],
    );
    occ.set(w.path, { id: w.id, hash: w.entry.contentHash });
  }

  return { ops, affectedIds: affected, conflicts };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ───────────────────────────── Phase 2 ─────────────────────────────

export interface PushLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface PlannedUpload {
  readonly objectId: string;
  readonly path: string;
  readonly expectedHash: string;
  readonly size: number;
}

export interface PushPlan {
  /** Complete entries of the next manifest. */
  readonly entries: Record<string, ManifestEntry>;
  readonly uploads: PlannedUpload[];
  /** Object ids whose remote object file is removed (now tombstoned). */
  readonly deletes: string[];
  readonly changeCount: number;
  /** More local changes exist than fit into this commit. */
  readonly morePending: boolean;
  /** Paths not uploaded because another file already uses the same name (differing only by case). */
  readonly nameCollisions: string[];
}

interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
  readonly upload: boolean;
  readonly isNew: boolean;
  readonly untrackedPath?: string;
}

export function planPush(
  base: Readonly<Record<string, ManifestEntry>>,
  remote: Manifest,
  view: LocalView,
  localMap: Record<string, string>,
  excludeIds: ReadonlySet<string>,
  limits: PushLimits,
  ctx: PlanContext,
): PushPlan {
  const version = remote.version + 1;
  const entries: Record<string, ManifestEntry> = { ...remote.entries };
  const keyOwner = new Map<string, string>();
  for (const [id, entry] of Object.entries(entries)) if (isLive(entry)) keyOwner.set(pathKey(entry.path), id);

  let changeCount = 0;
  const deletes: string[] = [];
  for (const id of [...view.deleted].sort()) {
    if (excludeIds.has(id)) continue;
    const b = base[id];
    if (!isLive(b)) continue;
    entries[id] = { deleted: true, deletedAtVersion: version, deletedBy: ctx.deviceId };
    keyOwner.delete(pathKey(b.path));
    deletes.push(id);
    changeCount++;
  }

  const candidates: Candidate[] = [];
  const presentSorted = [...view.present].sort((a, b) => (a[1].path < b[1].path ? -1 : a[1].path > b[1].path ? 1 : 0));
  for (const [id, file] of presentSorted) {
    if (excludeIds.has(id)) continue;
    const b = base[id];
    if (isLive(b)) {
      if (b.path === file.path && b.contentHash === file.hash) continue;
      candidates.push({ id, path: file.path, hash: file.hash, size: file.size, mtime: file.mtime, upload: b.contentHash !== file.hash, isNew: false });
    } else {
      // No base (created locally) or tombstoned remotely while modified here (resurrection with a new id).
      const newId = b ? ctx.newObjectId() : id;
      candidates.push({ id: newId, path: file.path, hash: file.hash, size: file.size, mtime: file.mtime, upload: true, isNew: true, untrackedPath: file.path });
    }
  }
  const untrackedSorted = [...view.untracked.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of untrackedSorted) {
    candidates.push({ id: "", path: file.path, hash: file.hash, size: file.size, mtime: file.mtime, upload: true, isNew: true, untrackedPath: file.path });
  }

  // Budget: path-only changes are always included, uploads until the per-commit limits are reached.
  let included: Candidate[] = [];
  let budgetFiles = 0;
  let budgetBytes = 0;
  let morePending = false;
  for (const c of candidates) {
    if (c.upload) {
      if (budgetFiles >= limits.maxFiles || (budgetFiles > 0 && budgetBytes + c.size > limits.maxBytes)) {
        morePending = true;
        continue;
      }
      budgetFiles++;
      budgetBytes += c.size;
    }
    included.push(c);
  }

  // Name uniqueness (case-insensitive) of the resulting manifest, computed to a fixpoint so that swaps
  // and chains of renames inside one commit are allowed while real collisions are excluded.
  const nameCollisions: string[] = [];
  for (;;) {
    const moving = new Set(included.filter((c) => c.id !== "").map((c) => c.id));
    const owners = new Map<string, string>();
    for (const [key, id] of keyOwner) if (!moving.has(id)) owners.set(key, id);
    const rejected = included.find((c, index) => {
      const key = pathKey(c.path);
      const token = c.id === "" ? `#${index}` : c.id;
      const owner = owners.get(key);
      if (owner !== undefined && owner !== token) return true;
      owners.set(key, token);
      return false;
    });
    if (!rejected) break;
    nameCollisions.push(rejected.path);
    included = included.filter((c) => c !== rejected);
  }

  const uploads: PlannedUpload[] = [];
  let bytes = 0;
  for (const c of included) {
    const id = c.id === "" ? ctx.newObjectId() : c.id;
    entries[id] = {
      path: c.path,
      size: c.size,
      contentHash: c.hash,
      modified: c.mtime,
      updatedAtVersion: version,
      updatedBy: ctx.deviceId,
    };
    if (c.untrackedPath !== undefined) localMap[c.untrackedPath] = id;
    if (c.upload) {
      uploads.push({ objectId: id, path: c.path, expectedHash: c.hash, size: c.size });
      bytes += c.size;
    }
    changeCount++;
  }

  return { entries, uploads, deletes, changeCount, morePending, nameCollisions };
}
