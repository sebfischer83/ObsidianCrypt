import type { EncryptedBlob } from "../crypto/EncryptionFormat";
import type { PublicVaultConfig } from "../manifest/VaultConfig";

/**
 * Backend-neutral view of the remote repository. Implementations: GitHub (REST git data API) and an
 * in-memory fake for tests. GitLab/Gitea/Forgejo/S3/WebDAV can be added without touching the engine.
 *
 * Plaintext safety: uploads accept only {@link EncryptedBlob} (constructible exclusively by encryption)
 * and the public config. Remote paths are derived from validated object ids only.
 */

export type HeadState =
  | { readonly kind: "ok"; readonly commit: string }
  /** Repository exists but has no commits at all. */
  | { readonly kind: "empty" }
  /** Repository exists and has commits, but not on the configured branch. */
  | { readonly kind: "branchMissing" };

export type RemoteChange =
  | { readonly kind: "putObject"; readonly objectId: string; readonly blob: EncryptedBlob }
  | { readonly kind: "deleteObject"; readonly objectId: string }
  | { readonly kind: "putManifest"; readonly blob: EncryptedBlob }
  | { readonly kind: "putConfig"; readonly config: PublicVaultConfig };

export interface CommitMetadata {
  /** Must not contain file names or other vault data. */
  readonly message: string;
}

export interface RemoteRepository {
  /** Current head of the configured branch. */
  getHead(): Promise<HeadState>;

  /** `.vaultsync/config` at a commit, or null if the file does not exist. */
  readConfig(commit: string): Promise<Uint8Array | null>;

  /** Encrypted manifest at a commit, or null if the file does not exist. */
  readManifest(commit: string): Promise<Uint8Array | null>;

  /** Encrypted object envelope at a commit. Throws GitHubError("NotFound") if missing. */
  readObject(commit: string, objectId: string): Promise<Uint8Array>;

  /** True if the commit's tree contains nothing but `.vaultsync/config` (freshly initialised vault). */
  isBootstrapCommit(commit: string): Promise<boolean>;

  /** True if the repository at this commit contains any file (used to refuse initialising foreign repos). */
  hasAnyFiles(commit: string): Promise<boolean>;

  /**
   * Creates the first commit containing only the public config and points the branch at it.
   * Fails with SyncError("ConcurrentRemoteUpdate") if the branch already exists.
   */
  initialize(config: PublicVaultConfig, meta: CommitMetadata): Promise<string>;

  /** Creates a commit on top of `parent` (does NOT move the branch). Returns the commit id. */
  createCommit(parent: string, changes: readonly RemoteChange[], meta: CommitMetadata): Promise<string>;

  /**
   * Atomically moves the branch from `expectedParent` to `newCommit` (compare-and-swap, never forced).
   * Throws SyncError("ConcurrentRemoteUpdate") if the branch no longer points to `expectedParent`.
   */
  updateHead(expectedParent: string, newCommit: string): Promise<void>;

  /** Parent commit ids (used to bind the manifest to its position in the history). */
  getParents(commit: string): Promise<string[]>;

  /** True if `ancestor` is reachable from `descendant` (or equal). False if unrelated or unknown. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}
