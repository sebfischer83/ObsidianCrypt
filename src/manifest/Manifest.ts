/**
 * The decrypted manifest: mapping of stable object ids to vault paths and content metadata.
 * It only ever exists in plaintext in memory and in the local state; remotely it is encrypted.
 */

export const MANIFEST_TYPE = "obsidian-encrypted-sync-manifest";

export interface LiveEntry {
  readonly path: string;
  readonly size: number;
  /** SHA-256 (hex) of the plaintext content. */
  readonly contentHash: string;
  /** Local modification time (ms) as reported by the device that uploaded this version. */
  readonly modified: number;
  readonly updatedAtVersion: number;
  readonly updatedBy: string;
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
}

export function isLive(entry: ManifestEntry | undefined | null): entry is LiveEntry {
  return !!entry && !("deleted" in entry);
}

export function isTombstone(entry: ManifestEntry | undefined | null): entry is Tombstone {
  return !!entry && "deleted" in entry && entry.deleted === true;
}

export function emptyManifest(vaultId: string, device: string, formatVersion = 1): Manifest {
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
