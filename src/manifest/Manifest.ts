/**
 * The decrypted manifest: mapping of stable object ids to vault paths and content metadata.
 * It only ever exists in plaintext in memory and in the local state; remotely it is encrypted.
 */

export const MANIFEST_TYPE = "obsidian-encrypted-sync-manifest";

/**
 * Manifest format written by this version. 2 = objects of large files may be chunk indexes (`chunks`).
 * Older plugin versions stop with "UnknownFormatVersion" instead of misreading such objects.
 */
export const MANIFEST_FORMAT_VERSION = 2;

/**
 * Format 3 = the manifest carries `movedTo` (the vault moved to another repository) or `movedFrom`
 * (archived earlier repositories). Written only when those fields are present, so vaults that never moved
 * stay readable by format-2 plugin versions.
 */
export const MOVE_FORMAT_VERSION = 3;
export const MAX_MANIFEST_FORMAT_VERSION = MOVE_FORMAT_VERSION;

export interface RepoLocation {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/** An earlier repository of this vault, readable up to `commit` (its "moved" marker). */
export interface ArchivedRepo extends RepoLocation {
  readonly commit: string;
}

/** Format version a manifest must declare given the fields it uses. */
export function formatVersionFor(manifest: Pick<Manifest, "movedTo" | "movedFrom">): number {
  return manifest.movedTo || (manifest.movedFrom && manifest.movedFrom.length > 0) ? MOVE_FORMAT_VERSION : MANIFEST_FORMAT_VERSION;
}

export interface LiveEntry {
  readonly path: string;
  readonly size: number;
  /** SHA-256 (hex) of the plaintext content. */
  readonly contentHash: string;
  /** Local modification time (ms) as reported by the device that uploaded this version. */
  readonly modified: number;
  readonly updatedAtVersion: number;
  readonly updatedBy: string;
  /** Number of chunks if the object is a chunk index (large file); absent for single objects. */
  readonly chunks?: number;
}

export interface Tombstone {
  readonly deleted: true;
  readonly deletedAtVersion: number;
  readonly deletedBy: string;
}

export type ManifestEntry = LiveEntry | Tombstone;

export interface Manifest {
  readonly type: typeof MANIFEST_TYPE;
  readonly formatVersion: number;
  readonly vaultId: string;
  /** Strictly increasing by one per commit. */
  readonly version: number;
  /** Commit this manifest's commit was created on top of (null for the first manifest). */
  readonly parentCommit: string | null;
  readonly device: string;
  readonly updatedAt: number;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
  /** Terminal marker: this repository is retired, the vault continues there (format 3). */
  readonly movedTo?: RepoLocation;
  /** Earlier repositories of this vault, newest first (format 3). Carried over by every commit. */
  readonly movedFrom?: readonly ArchivedRepo[];
}

export function isLive(entry: ManifestEntry | undefined | null): entry is LiveEntry {
  return !!entry && !("deleted" in entry);
}

export function isTombstone(entry: ManifestEntry | undefined | null): entry is Tombstone {
  return !!entry && "deleted" in entry && entry.deleted === true;
}

export function emptyManifest(vaultId: string, device: string, formatVersion = MANIFEST_FORMAT_VERSION): Manifest {
  return {
    type: MANIFEST_TYPE,
    formatVersion,
    vaultId,
    version: 0,
    parentCommit: null,
    device,
    updatedAt: 0,
    entries: {},
  };
}

export function sameContent(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (isLive(a) && isLive(b)) return a.contentHash === b.contentHash && a.size === b.size;
  return false;
}

/** Semantic equality of two entries (ignores bookkeeping fields like updatedAtVersion). */
export function entriesEquivalent(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (!a || !b) return a === b;
  if (isTombstone(a) && isTombstone(b)) return true;
  if (isLive(a) && isLive(b)) return a.path === b.path && a.contentHash === b.contentHash && a.size === b.size;
  return false;
}

export function liveEntries(manifest: Manifest): Array<[string, LiveEntry]> {
  const out: Array<[string, LiveEntry]> = [];
  for (const [id, entry] of Object.entries(manifest.entries)) if (isLive(entry)) out.push([id, entry]);
  return out;
}
