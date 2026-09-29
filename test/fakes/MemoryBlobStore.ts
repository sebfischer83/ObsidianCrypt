import { RemoteError } from "../../src/errors/RemoteError";
import { assertStoreKey, type BlobStore, type ReplaceResult, type StoredObject } from "../../src/store/BlobStore";
import { toHex } from "../../src/util/bytes";

export type WriteFault = "crashBefore" | "crashAfter" | "ambiguous";

export class StoreCrash extends Error {
  constructor(readonly write: number) {
    super(`simulated crash at write ${write}`);
  }
}

let instances = 0;

/**
 * In-memory BlobStore with the failure modes real object stores have: crashes before/after any write, lost
 * responses (write applied, client sees a network error), offline periods, non-atomic compare-and-swap
 * (WebDAV) and servers that silently ignore conditional headers (must fail the capability probe).
 */
export class MemoryBlobStore implements BlobStore {
  readonly id = `memory-${++instances}-${toHex(globalThis.crypto.getRandomValues(new Uint8Array(4)))}`;
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  casAtomic = true;
  /** Non-compliant server: conditional headers are ignored. */
  ignoreConditions = false;
  offline = false;
  requestCount = 0;
  writeCount = 0;
  /** Fault injected at the n-th write (1-based) from now on, counted over create + replace. */
  fault: { at: number; kind: WriteFault } | null = null;
  /**
   * Non-atomic CAS: called after a replace passed its precondition but before it is applied – a concurrent
   * writer may slip in here (both writes then "succeed", the later one wins).
   */
  onReplaceChecked: ((key: string) => Promise<void>) | null = null;
  /** Server that derives ETags from size + modification second (repeats for same-size writes). */
  mtimeEtags = false;
  /** The next n creates answer "exists" without storing anything (eventual consistency / odd 412 mapping). */
  phantomExists = 0;
  /** Called after a write was applied, before any injected fault is raised (e.g. a competing writer). */
  afterApply: ((key: string) => void) | null = null;
  private etagCounter = 0;

  private touch(): void {
    this.requestCount++;
    if (this.offline) throw new RemoteError("Network");
  }

  private nextEtag(bytes: Uint8Array): string {
    return this.mtimeEtags ? `"${bytes.length}-1790000000"` : `"e${++this.etagCounter}"`;
  }

  private async write(key: string, apply: () => void): Promise<void> {
    const n = ++this.writeCount;
    const fault = this.fault && this.fault.at === n ? this.fault.kind : null;
    if (fault) this.fault = null;
    if (fault === "crashBefore") throw new StoreCrash(n);
    apply();
    this.afterApply?.(key);
    if (fault === "crashAfter") throw new StoreCrash(n);
    if (fault === "ambiguous") throw new RemoteError("Network");
  }

  async get(key: string, maxBytes: number): Promise<StoredObject | null> {
    assertStoreKey(key);
    this.touch();
    const entry = this.objects.get(key);
    if (!entry) return null;
    if (entry.bytes.length > maxBytes) throw new RemoteError("PayloadTooLarge");
    return { bytes: entry.bytes.slice(), etag: entry.etag };
  }

  async create(key: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    assertStoreKey(key);
    this.touch();
    if (this.phantomExists > 0) {
      this.phantomExists--;
      return "exists";
    }
    if (this.objects.has(key) && !this.ignoreConditions) return "exists";
    await this.write(key, () => this.objects.set(key, { bytes: bytes.slice(), etag: this.nextEtag(bytes) }));
    return "created";
  }

  async replace(key: string, bytes: Uint8Array, expectedEtag: string): Promise<ReplaceResult> {
    assertStoreKey(key);
    this.touch();
    const entry = this.objects.get(key);
    if (!this.ignoreConditions && entry?.etag !== expectedEtag) return { ok: false };
    if (!this.casAtomic && this.onReplaceChecked) {
      const hook = this.onReplaceChecked;
      this.onReplaceChecked = null;
      await hook(key);
    }
    const etag = this.nextEtag(bytes);
    await this.write(key, () => this.objects.set(key, { bytes: bytes.slice(), etag }));
    return { ok: true, etag };
  }

  async listChildren(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    this.touch();
    const prefix = dir === "" ? "" : `${dir}/`;
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) files.add(rest);
      else dirs.add(rest.slice(0, slash));
    }
    return { files: [...files].sort(), dirs: [...dirs].sort() };
  }

  async deleteOwnProbe(key: string): Promise<void> {
    assertStoreKey(key);
    if (!key.startsWith("probe/")) throw new Error("only probe keys may be deleted");
    this.touch();
    this.objects.delete(key);
  }

  /** Everything an attacker with full access to the storage could see (keys and contents). */
  everythingStored(): Uint8Array[] {
    const enc = new TextEncoder();
    return [...this.objects].flatMap(([key, entry]) => [enc.encode(key), entry.bytes]);
  }
}
