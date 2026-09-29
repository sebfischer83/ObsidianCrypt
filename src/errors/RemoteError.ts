import { VaultSyncError } from "./VaultSyncError";

export type RemoteErrorCategory =
  | "Authentication"
  | "Authorization"
  | "RateLimit"
  | "Conflict"
  | "Network"
  | "RepositoryMissing"
  | "BranchMissing"
  | "NotFound"
  | "EmptyRepository"
  | "ServerError"
  | "InvalidResponse"
  | "PayloadTooLarge"
  /** The storage does not provide a capability sync depends on (e.g. conditional writes). */
  | "Unsupported"
  /** The device clock differs too much from the server's (signed requests are rejected). */
  | "ClockSkew";

const MESSAGES: Record<RemoteErrorCategory, string> = {
  Authentication: "Authentication with the storage failed. Check the credentials.",
  Authorization: "The credentials lack the required permissions for the storage location.",
  RateLimit: "The storage's request limit was reached. Sync will resume later.",
  Conflict: "The remote storage was changed concurrently.",
  Network: "The storage is not reachable (offline or network error).",
  RepositoryMissing: "The configured storage location does not exist or is not accessible.",
  BranchMissing: "The configured branch does not exist in the repository.",
  NotFound: "A requested remote object was not found.",
  EmptyRepository: "The storage location is empty.",
  ServerError: "The storage returned a server error.",
  InvalidResponse: "The storage returned an unexpected response.",
  PayloadTooLarge: "The request is too large for the storage.",
  Unsupported: "The storage does not support conditional writes reliably, which safe synchronisation requires.",
  ClockSkew: "The device clock differs too much from the storage server's clock. Check the date and time settings.",
};

/** Errors of a remote backend (GitHub, S3, WebDAV). Never contains credentials, request bodies or secret URLs. */
export class RemoteError extends VaultSyncError {
  readonly domain = "remote" as const;

  constructor(
    readonly category: RemoteErrorCategory,
    readonly status: number | null = null,
    /** Milliseconds after which a retry makes sense (rate limits). */
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(status !== null ? `${MESSAGES[category]} (HTTP ${status})` : MESSAGES[category], options);
  }

  get retryable(): boolean {
    return this.category === "Network" || this.category === "ServerError" || this.category === "RateLimit";
  }
}
