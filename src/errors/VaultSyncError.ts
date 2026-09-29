/**
 * Base class of all domain errors. Messages are fixed, human readable strings and must never
 * contain secrets, file contents or (unless explicitly allowed) file paths.
 */
export abstract class VaultSyncError extends Error {
  abstract readonly domain: "crypto" | "remote" | "sync" | "vault" | "state" | "format";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options && "cause" in options) {
      // Keep the cause for diagnostics, but callers must not display it verbatim.
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

/** GitHub token formats (classic, fine-grained, OAuth, app, refresh) and bearer headers. */
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b|Bearer\s+\S+/g;
const MAX_FOREIGN_MESSAGE = 200;

/** Removes anything that looks like a credential from a diagnostic string. */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text.replace(TOKEN_PATTERN, "<redacted>");
  for (const secret of extraSecrets) if (secret.length >= 4) out = out.split(secret).join("<redacted>");
  return out;
}

/**
 * Formats any error for display. Domain errors carry fixed messages; for foreign errors (platform/API) the
 * name and a redacted, shortened message are shown so problems can be diagnosed.
 */
export function describeError(error: unknown, extraSecrets: readonly string[] = []): string {
  if (error instanceof VaultSyncError) return error.message;
  if (error instanceof Error) {
    const message = redactSecrets(error.message ?? "", extraSecrets).slice(0, MAX_FOREIGN_MESSAGE);
    return message ? `Unexpected error (${error.name}: ${message})` : `Unexpected error (${error.name})`;
  }
  return "Unexpected error";
}

/**
 * Writes unexpected (non-domain) errors to the developer console with credentials redacted. Only when the
 * user enabled debug logging, because platform error messages may contain file paths.
 */
export function logUnexpected(enabled: boolean, context: string, error: unknown, extraSecrets: readonly string[] = []): void {
  if (!enabled) return;
  if (error instanceof VaultSyncError && !(error as { cause?: unknown }).cause) return;
  const root = error instanceof VaultSyncError ? (error as { cause?: unknown }).cause : error;
  const text = root instanceof Error ? `${root.name}: ${root.message}\n${root.stack ?? ""}` : String(root);
  console.error(`[encrypted-sync] ${context}: ${redactSecrets(text, extraSecrets)}`);
}
