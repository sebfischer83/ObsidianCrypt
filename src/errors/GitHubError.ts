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
  | "PayloadTooLarge";

const MESSAGES: Record<RemoteErrorCategory, string> = {
  Authentication: "GitHub authentication failed. Check the access token.",
  Authorization: "The access token lacks the required repository permissions.",
  RateLimit: "GitHub API rate limit reached. Sync will resume later.",
  Conflict: "The remote repository was changed concurrently.",
  Network: "GitHub is not reachable (offline or network error).",
  RepositoryMissing: "The configured repository does not exist or is not accessible.",
  BranchMissing: "The configured branch does not exist in the repository.",
  NotFound: "A requested remote object was not found.",
  EmptyRepository: "The repository is empty.",
  ServerError: "GitHub returned a server error.",
  InvalidResponse: "GitHub returned an unexpected response.",
  PayloadTooLarge: "The request is too large for the GitHub API.",
};

/** Errors of the remote backend. Never contains the token, request bodies or URLs with secrets. */
export class GitHubError extends VaultSyncError {
  readonly domain = "github" as const;

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
