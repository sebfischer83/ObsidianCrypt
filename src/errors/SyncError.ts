import { VaultSyncError } from "./VaultSyncError";

export type SyncErrorCode =
  | "ConcurrentRemoteUpdate"
  | "Blocked"
  | "NotConfigured"
  | "LimitExceeded"
  | "InvalidManifest"
  | "InvalidConfig"
  | "UnsupportedFormatVersion"
  | "RetriesExhausted"
  | "LocalWriteFailed"
  | "UnsyncedChanges"
  | "InvalidState";

/**
 * Reasons that stop synchronisation until the user intervenes. The local vault is never touched
 * while blocked.
 */
export type BlockReason =
  | "BranchDeleted"
  | "HistoryRewritten"
  | "ManifestMissing"
  | "ManifestCorrupted"
  | "ConfigMissing"
  | "ConfigCorrupted"
  | "UnknownFormatVersion"
  | "ForeignVault"
  | "RepositoryNotEmpty"
  | "VaultMoved";

const BLOCK_MESSAGES: Record<BlockReason, string> = {
  BranchDeleted: "The remote branch was deleted. Synchronisation stopped to protect local data.",
  HistoryRewritten: "The remote history was rewritten (force-push or rollback). Synchronisation stopped to protect local data.",
  ManifestMissing: "The encrypted manifest is missing in the repository. Synchronisation stopped.",
  ManifestCorrupted: "The encrypted manifest is corrupted or was manipulated. Synchronisation stopped.",
  ConfigMissing: "The repository configuration is missing. Synchronisation stopped.",
  ConfigCorrupted: "The repository configuration is corrupted or was manipulated. Synchronisation stopped.",
  UnknownFormatVersion: "The repository uses a newer format version. Please update the plugin.",
  ForeignVault: "The repository belongs to a different encrypted vault. Synchronisation stopped.",
  RepositoryNotEmpty: "The repository contains files that are not an encrypted vault. Use an empty repository.",
  VaultMoved: "This vault moved to another repository. Open the status dialog to switch to it.",
};

const MESSAGES: Record<Exclude<SyncErrorCode, "Blocked">, string> = {
  ConcurrentRemoteUpdate: "Another device updated the repository concurrently.",
  NotConfigured: "Encrypted sync is not configured yet.",
  LimitExceeded: "A safety limit was exceeded.",
  InvalidManifest: "The manifest failed validation.",
  InvalidConfig: "The repository configuration failed validation.",
  UnsupportedFormatVersion: "Unsupported format version.",
  RetriesExhausted: "Synchronisation did not converge after several attempts; it will be retried later.",
  LocalWriteFailed: "Writing a file to the local vault failed. The previous file was kept.",
  UnsyncedChanges: "The file has changes that are not synchronised yet. Sync first or restore the version as a copy.",
  InvalidState: "The local sync state is invalid.",
};

export class SyncError extends VaultSyncError {
  readonly domain = "sync" as const;
  readonly blockReason: BlockReason | null;

  constructor(readonly code: SyncErrorCode, detailOrReason?: string, options?: { cause?: unknown }) {
    const message =
      code === "Blocked"
        ? BLOCK_MESSAGES[detailOrReason as BlockReason] ?? "Synchronisation blocked."
        : detailOrReason
          ? `${MESSAGES[code]} (${detailOrReason})`
          : MESSAGES[code];
    super(message, options);
    this.blockReason = code === "Blocked" ? (detailOrReason as BlockReason) : null;
  }

  static blocked(reason: BlockReason, options?: { cause?: unknown }): SyncError {
    return new SyncError("Blocked", reason, options);
  }
}
