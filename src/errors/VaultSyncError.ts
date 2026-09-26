/**
 * Base class of all domain errors. Messages are fixed, human readable strings and must never
 * contain secrets, file contents or (unless explicitly allowed) file paths.
 */
export abstract class VaultSyncError extends Error {
  abstract readonly domain: "crypto" | "github" | "sync" | "vault" | "state" | "format";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options && "cause" in options) {
      // Keep the cause for diagnostics, but callers must not display it verbatim.
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

/** Formats any error for display/logging without leaking data from foreign error messages. */
export function describeError(error: unknown): string {
  if (error instanceof VaultSyncError) return error.message;
  if (error instanceof Error) return `Unexpected error (${error.name})`;
  return "Unexpected error";
}
