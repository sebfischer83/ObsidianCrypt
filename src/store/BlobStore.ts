/**
 * The minimal storage primitive the object-store backends (S3, WebDAV) provide. Keys are relative to the
 * configured location (bucket prefix / folder) and consist of `[A-Za-z0-9./-]` only.
 *
 * Errors are RemoteError (Network, Authentication, RateLimit, …); a missing key is not an error.
 */

export interface StoredObject {
  readonly bytes: Uint8Array;
  /** Strong entity tag of this version, null if the backend reports none. */
  readonly etag: string | null;
}

export type ReplaceResult = { readonly ok: true; readonly etag: string | null } | { readonly ok: false };

export interface BlobStore {
  /** Namespace for caches (canonical location key). */
  readonly id: string;
  /**
   * Whether a conditional replace is atomic (S3). WebDAV servers check the precondition before writing without
   * a lock, so a simultaneous writer can slip in; the repository then verifies its head update afterwards.
   */
  readonly casAtomic: boolean;

  /** The object, or null if it does not exist. Throws RemoteError("PayloadTooLarge") above `maxBytes`. */
  get(key: string, maxBytes: number): Promise<StoredObject | null>;

  /** Create-only write (If-None-Match: *). Never overwrites; "exists" if something is already stored. */
  create(key: string, bytes: Uint8Array): Promise<"created" | "exists">;

  /**
   * Replaces the object only if it still has `expectedEtag` (If-Match). ok:false if it does not (412/409).
   * An unknown outcome (connection lost after sending) throws RemoteError("Network").
   */
  replace(key: string, bytes: Uint8Array, expectedEtag: string): Promise<ReplaceResult>;

  /** Direct children of a folder ("" = root): file names and sub-folder names, without the folder prefix. */
  listChildren(dir: string): Promise<{ files: string[]; dirs: string[] }>;

  /** Deletes a key below `probe/` (capability probes only – nothing else is ever deleted). */
  deleteOwnProbe(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9./-]{0,300}$/;

/** Keys are built from constants and validated ids only; this guards every backend implementation. */
export function assertStoreKey(key: string): void {
  if (!KEY.test(key) || key.includes("//") || key.endsWith("/") || key.split("/").some((s) => s === "." || s === "..")) throw new Error("invalid store key");
}
