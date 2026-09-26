import type { CryptoProvider } from "../crypto/CryptoProvider";
import type { LocalFileInfo, LocalFileSystem } from "./LocalFileSystem";
import { isValidVaultPath } from "./PathUtils";
import type { SyncFilter } from "./SyncFilter";

export interface HashCacheEntry {
  readonly size: number;
  readonly mtime: number;
  readonly hash: string;
}

export interface ScannedFile extends LocalFileInfo {
  readonly hash: string;
}

export interface ScanResult {
  /** Managed files with their current content hash. */
  readonly files: Map<string, ScannedFile>;
  /** Present but not synchronised (too large / unreadable / invalid name). Never treated as deleted. */
  readonly skipped: Map<string, "tooLarge" | "unreadable" | "invalidPath">;
  readonly hashedCount: number;
}

export interface ScanOptions {
  readonly maxFileSize: number;
}

/**
 * Lists the vault and hashes only files whose size or mtime changed since the last scan. A sync with one
 * changed note therefore reads and hashes exactly one file.
 */
export async function scanVault(
  fs: LocalFileSystem,
  filter: SyncFilter,
  hashCache: Record<string, HashCacheEntry>,
  crypto: CryptoProvider,
  options: ScanOptions,
): Promise<ScanResult> {
  const listed = await fs.list(filter);
  const files = new Map<string, ScannedFile>();
  const skipped = new Map<string, "tooLarge" | "unreadable" | "invalidPath">();
  const seen = new Set<string>();
  let hashedCount = 0;

  for (const info of listed) {
    if (!filter.includes(info.path)) continue;
    seen.add(info.path);
    if (!isValidVaultPath(info.path)) {
      skipped.set(info.path, "invalidPath");
      continue;
    }
    if (info.size > options.maxFileSize) {
      skipped.set(info.path, "tooLarge");
      continue;
    }
    const cached = hashCache[info.path];
    if (cached && cached.size === info.size && cached.mtime === info.mtime) {
      files.set(info.path, { ...info, hash: cached.hash });
      continue;
    }
    let data: Uint8Array;
    try {
      data = await fs.read(info.path);
    } catch (error: unknown) {
      if (error instanceof Error) {
        skipped.set(info.path, "unreadable");
        continue;
      }
      throw error;
    }
    if (data.length > options.maxFileSize) {
      skipped.set(info.path, "tooLarge");
      continue;
    }
    const hash = await crypto.hash(data);
    hashedCount++;
    // Use the actually read size; mtime from the listing.
    const entry: ScannedFile = { path: info.path, size: data.length, mtime: info.mtime, hash };
    hashCache[info.path] = { size: info.size, mtime: info.mtime, hash };
    files.set(info.path, entry);
  }

  for (const path of Object.keys(hashCache)) {
    if (!seen.has(path)) delete hashCache[path];
  }
  return { files, skipped, hashedCount };
}
