import type { CryptoProvider } from "../crypto/CryptoProvider";
import { isLive } from "../manifest/Manifest";
import type { LocalState } from "../state/LocalState";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import { pathKey } from "../vault/PathUtils";

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
