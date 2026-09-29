import { RemoteError } from "../errors/RemoteError";
import type { CryptoProvider } from "../crypto/CryptoProvider";
import { bytesEqual, toHex, utf8Encode } from "../util/bytes";
import type { BlobStore } from "./BlobStore";

export interface ProbeReport {
  readonly createOnly: boolean;
  readonly conditionalReplace: boolean;
  readonly strongEtags: boolean;
  readonly readAfterWrite: boolean;
}

/** Same-size rewrites in quick succession: ETags derived from mtime (seconds) + size would repeat here. */
const REWRITES = 4;

/**
 * Verifies that a store really honours what safe synchronisation depends on: create-only writes, conditional
 * replace with 412 on a stale ETag, strong ETags that change with every write – also for same-size content
 * written within the same second – and read-after-write consistency. Several servers and gateways silently
 * ignore the conditional headers or derive ETags from modification time and size; they must be refused,
 * because without a reliable compare-and-swap two devices could overwrite each other's head update.
 * Throws RemoteError("Unsupported") on the first violation; only writes (and removes) a key below `probe/`.
 */
export async function probeStore(store: BlobStore, crypto: CryptoProvider): Promise<ProbeReport> {
  const key = `probe/${toHex(crypto.randomBytes(16))}`;
  const content = (): Uint8Array => utf8Encode(`probe-${toHex(crypto.randomBytes(8))}`); // always the same length
  const fail = (what: string): never => {
    throw new RemoteError("Unsupported", null, null, { cause: new Error(what) });
  };
  const strong = (etag: string | null | undefined): string => {
    if (!etag || etag.startsWith("W/")) fail("no strong ETag");
    return etag as string;
  };
  try {
    const first = content();
    if ((await store.create(key, first)) !== "created") fail("create reported an existing object");
    if ((await store.create(key, content())) !== "exists") fail("create-only write overwrote an existing object");
    const initial = await store.get(key, 1024);
    if (!initial || !bytesEqual(initial.bytes, first)) fail("read after write returned other data");
    let etag = strong(initial?.etag);
    const seen = new Set([etag]);
    if ((await store.replace(key, content(), `"stale-${toHex(crypto.randomBytes(8))}"`)).ok) fail("replace ignored a stale ETag");
    for (let i = 0; i < REWRITES; i++) {
      const next = content();
      const replaced = await store.replace(key, next, etag);
      if (!replaced.ok) fail("replace with the current ETag was refused");
      const read = await store.get(key, 1024);
      if (!read || !bytesEqual(read.bytes, next)) fail("read after replace returned old data");
      const fresh = strong(read?.etag);
      if (seen.has(fresh)) fail("ETag repeated for different content");
      seen.add(fresh);
      if ((await store.replace(key, content(), etag)).ok) fail("replace accepted an outdated ETag");
      etag = fresh;
    }
    return { createOnly: true, conditionalReplace: true, strongEtags: true, readAfterWrite: true };
  } finally {
    await store.deleteOwnProbe(key).catch(() => undefined);
  }
}
