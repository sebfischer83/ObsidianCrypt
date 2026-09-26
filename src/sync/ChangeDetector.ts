import { isLive, type ManifestEntry } from "../manifest/Manifest";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import type { SyncFilter } from "../vault/SyncFilter";
import { pathKey } from "../vault/PathUtils";
import type { ScanResult, ScannedFile } from "../vault/VaultScanner";

/**
 * Local view of the vault relative to the merge base, keyed by stable object id.
 */
export interface LocalView {
  /** Tracked object ids that exist locally, with their current path and hash. */
  readonly present: Map<string, ScannedFile>;
  /** Ids that are live in the base and whose file is really gone locally (local delete). */
  readonly deleted: Set<string>;
  /** Ids not managed on this device right now (excluded, too large, unreadable). Never "deleted". */
  readonly unmanaged: Set<string>;
  /**
   * Subset of `unmanaged` whose file still exists locally (skipped or stale index). Their merge base must
   * not advance: the local content is unknown to the merge and would otherwise overwrite remote edits later.
   */
  readonly heldBack: Set<string>;
  /** Live base ids that were never materialised locally (e.g. lost state) – treated as "absent", never deleted. */
  readonly absent: Set<string>;
  /** Managed local files without an object id yet. */
  readonly untracked: Map<string, ScannedFile>;
  /** Present but skipped files (still occupy their path). */
  readonly skipped: ReadonlyMap<string, string>;
}

/**
 * Builds the local view. Identity comes from `localMap` (kept current by rename events); as a fallback a
 * missing tracked file whose unchanged content re-appears exactly once elsewhere is detected as a rename.
 * Mutates `localMap` to reflect what was found.
 */
export async function buildLocalView(
  scan: ScanResult,
  localMap: Record<string, string>,
  base: Readonly<Record<string, ManifestEntry>>,
  filter: SyncFilter,
  fs: LocalFileSystem,
): Promise<LocalView> {
  const present = new Map<string, ScannedFile>();
  const unmanaged = new Set<string>();
  const heldBack = new Set<string>();
  const missing = new Set<string>();
  const claimedPaths = new Set<string>();
  const scannedByKey = new Map<string, string>();
  for (const path of scan.files.keys()) scannedByKey.set(pathKey(path), path);

  for (const path of Object.keys(localMap).sort()) {
    const id = localMap[path] as string;
    if (present.has(id)) {
      // Corrupt duplicate mapping: keep the first, forget the second (file becomes untracked, never lost).
      delete localMap[path];
      continue;
    }
    let file = scan.files.get(path);
    if (!file) {
      // Case-insensitive file systems: the same slot now spelled differently (renamed or re-created).
      const alt = scannedByKey.get(pathKey(path));
      if (alt !== undefined && alt !== path && !claimedPaths.has(alt) && localMap[alt] === undefined) {
        file = scan.files.get(alt);
        delete localMap[path];
        localMap[alt] = id;
      }
    }
    if (file) {
      present.set(id, file);
      claimedPaths.add(file.path);
      missing.delete(id);
      continue;
    }
    if (scan.skipped.has(path)) {
      unmanaged.add(id);
      heldBack.add(id);
      continue;
    }
    if (!filter.includes(path)) {
      // Now excluded on this device: stop tracking, but never interpret as a deletion.
      delete localMap[path];
      unmanaged.add(id);
      continue;
    }
    // If another scanned file occupies the same (case-insensitive) slot, this file is really gone; only
    // otherwise ask the file system, whose case-insensitive exists() would report that other file.
    const slotTakenByOther = scannedByKey.has(pathKey(path));
    if (!slotTakenByOther && (await fs.exists(path))) {
      // Listed index is stale; do not risk interpreting it as a delete.
      unmanaged.add(id);
      heldBack.add(id);
      continue;
    }
    if (isLive(base[id])) {
      // Keep the mapping until the deletion is committed (the view is built more than once per sync).
      missing.add(id);
    } else {
      // Never synchronised or already tombstoned: nothing to delete remotely, forget it.
      delete localMap[path];
    }
  }

  const untracked = new Map<string, ScannedFile>();
  for (const [path, file] of scan.files) if (!claimedPaths.has(path)) untracked.set(path, file);

  const absent = new Set<string>();
  for (const [id, entry] of Object.entries(base)) {
    if (!isLive(entry) || present.has(id) || missing.has(id) || unmanaged.has(id)) continue;
    if (scan.skipped.has(entry.path)) {
      unmanaged.add(id);
      heldBack.add(id);
      continue;
    }
    if (!filter.includes(entry.path)) {
      unmanaged.add(id);
      continue;
    }
    const file = untracked.get(entry.path);
    if (file && file.hash === entry.contentHash) {
      // Same content at the base path but not mapped (lost state): reclaim identity.
      present.set(id, file);
      untracked.delete(entry.path);
      localMap[entry.path] = id;
      continue;
    }
    absent.add(id);
  }

  // Hash based rename detection for tracked files that vanished (e.g. renamed while the plugin was not running).
  const byHash = new Map<string, string[]>();
  for (const [path, file] of untracked) {
    const list = byHash.get(file.hash) ?? [];
    list.push(path);
    byHash.set(file.hash, list);
  }
  const missingByHash = new Map<string, string[]>();
  for (const id of missing) {
    const entry = base[id];
    if (!isLive(entry)) continue;
    const list = missingByHash.get(entry.contentHash) ?? [];
    list.push(id);
    missingByHash.set(entry.contentHash, list);
  }
  for (const [hash, ids] of missingByHash) {
    const candidates = byHash.get(hash);
    if (ids.length === 1 && candidates && candidates.length === 1) {
      const id = ids[0] as string;
      const path = candidates[0] as string;
      const file = untracked.get(path) as ScannedFile;
      present.set(id, file);
      untracked.delete(path);
      missing.delete(id);
      for (const [p, mapped] of Object.entries(localMap)) if (mapped === id) delete localMap[p];
      localMap[path] = id;
    }
  }

  const deleted = new Set<string>();
  for (const id of missing) if (isLive(base[id])) deleted.add(id);

  return { present, deleted, unmanaged, heldBack, absent, untracked, skipped: scan.skipped };
}
