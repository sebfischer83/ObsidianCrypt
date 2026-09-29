/**
 * Minimal file system abstraction over the local vault. The Obsidian implementation uses the Vault API
 * for regular files and the DataAdapter for hidden files; tests use an in-memory implementation.
 * All paths are vault-relative and normalised (see PathUtils).
 */

export interface LocalFileInfo {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

export interface ListFilter {
  /** Whether a folder should be descended into (lets implementations skip e.g. `.git`). */
  shouldDescend(folderPath: string): boolean;
  /** Whether a file should be reported. */
  includes(filePath: string): boolean;
}

export interface LocalFileSystem {
  list(filter: ListFilter): Promise<LocalFileInfo[]>;

  /** Null if the path does not exist or is a folder. */
  stat(path: string): Promise<LocalFileInfo | null>;

  read(path: string): Promise<Uint8Array>;

  /**
   * Writes the complete content in one call (creating parent folders). The data is fully decrypted and
   * verified before this is called; implementations must not write partially on their side either where
   * the platform allows it.
   */
  write(path: string, data: Uint8Array, mtime?: number): Promise<void>;

  /** Creates a new file (creating parent folders). Must fail if anything exists at `path` – never overwrites. */
  create(path: string, data: Uint8Array): Promise<void>;

  /** Renames a file. Must fail if `to` already exists. Must not rewrite links in other notes. */
  rename(from: string, to: string): Promise<void>;

  /** Moves a file to the (recoverable) trash. */
  trash(path: string): Promise<void>;

  exists(path: string): Promise<boolean>;
}
