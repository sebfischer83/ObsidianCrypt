import type { CryptoProvider } from "../crypto/CryptoProvider";
import { isLive } from "../manifest/Manifest";
import type { LocalState } from "../state/LocalState";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { pathKey } from "../vault/PathUtils";
import { SyncError } from "../errors/SyncError";

/** Object id tracked for a vault path (case-insensitive fallback), or null if never synchronised. */
export function trackedObjectId(state: LocalState, path: string): string | null {
  const direct = state.localMap[path];
  if (direct !== undefined) return direct;
  const key = pathKey(path);
  for (const [tracked, id] of Object.entries(state.localMap)) if (pathKey(tracked) === key) return id;
  return null;
}

/**
 * True if the file's current content is exactly what the last synchronised manifest records for it, i.e.
 * it is stored in the remote history and overwriting the local file loses nothing.
 */
export async function isSyncedContent(state: LocalState, crypto: CryptoProvider, fs: LocalFileSystem, path: string, objectId: string): Promise<boolean> {
  if (trackedObjectId(state, path) !== objectId) return false;
  const entry = state.remote?.entries[objectId];
  if (!isLive(entry)) return false;
  try {
    return (await crypto.hash(await fs.read(path))) === entry.contentHash;
  } catch {
    return false;
  }
}

/**
 * Creates `candidates(n)` for n = 0, 1, … at the first free name and returns it. Uses the create-only file
 * API, so a file that appears at a candidate name concurrently is never overwritten.
 */
export async function createAtFreeName(fs: LocalFileSystem, data: Uint8Array, candidates: (n: number) => string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const candidate = candidates(n);
    if (await fs.exists(candidate)) continue;
    try {
      await fs.create(candidate, data);
      return candidate;
    } catch (error: unknown) {
      if (await fs.exists(candidate)) continue; // taken in the meantime: try the next name
      throw error;
    }
  }
  throw new SyncError("InvalidState", "no free file name");
}

/**
 * Replaces a file's content only if it still has `expectedHash` (re-read right before writing) and reports
 * whether the written content is what is on disk afterwards (an editor may save in between; its content then
 * stays and is simply not replaced).
 */
export async function replaceIfUnchanged(fs: LocalFileSystem, crypto: CryptoProvider, path: string, expectedHash: string, data: Uint8Array): Promise<boolean> {
  if ((await crypto.hash(await fs.read(path))) !== expectedHash) throw new SyncError("InvalidState", "the file changed in the meantime; try again");
  await fs.write(path, data);
  return (await crypto.hash(await fs.read(path))) === (await crypto.hash(data));
}
