import type { CryptoProvider } from "../crypto/CryptoProvider";
import type { EncryptedBlob } from "../crypto/EncryptionFormat";
import { CryptoError } from "../errors/CryptoError";
import { RemoteError } from "../errors/RemoteError";
import { SyncError } from "../errors/SyncError";
import { serializeVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
import { assertEncrypted, isMigrationMessage, parseCommitDevice } from "../remote/RemoteLayout";
import type { CommitMetadata, HeadState, ObjectRevision, RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import { toHex } from "../util/bytes";
import { HEX_32, HEX_64 } from "../util/validate";
import type { BlobStore } from "./BlobStore";
import { probeStore } from "./CapabilityProbe";
import { ImmutableCache } from "./ImmutableCache";
import {
  encodeCommit,
  encodeHead,
  encodeMarker,
  encodePage,
  encodeRoot,
  encodeSub,
  INLINE_REVISIONS,
  isStoreMessage,
  parseCommit,
  parseHead,
  parseMarker,
  parsePage,
  parseRoot,
  parseSub,
  type CommitRecord,
  type HeadRecord,
  type Leaf,
  type Revision,
  type RevPage,
  type RootTree,
  type SubTree,
} from "./StoreRecords";

const MAX_HEAD_BYTES = 4 * 1024;
const MAX_MARKER_BYTES = 1024;
const MAX_COMMIT_BYTES = 64 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
/** Largest blob read: a single object up to the hard file limit plus envelope overhead. */
const MAX_BLOB_BYTES = 257 * 1024 * 1024;
const MAX_ANCESTRY_STEPS = 4096;
const EMPTY_ROOT: RootTree = { f: {} };

/** Shared across instances: records are immutable, so a cached copy stays valid (keyed per store and kind). */
const sharedCache = new ImmutableCache<unknown>();
/** Stores verified in this session (capability probe passed; layout marker is ours). */
const probedStores = new Set<string>();
const markedStores = new Set<string>();

export interface ObjectStoreOptions {
  readonly crypto: CryptoProvider;
  /** Delay before re-reading HEAD after an update on stores with non-atomic compare-and-swap. */
  readonly verifyDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Parallel uploads per commit (≥ 1). */
  readonly concurrency?: number;
  /** Test hook: skip the capability probe (the probe has its own tests). */
  readonly skipProbe?: boolean;
}

/**
 * The git semantics the sync engine relies on (single-parent commits, snapshots at any commit, compare-and-swap
 * head, per-object history) on top of a plain object store. See docs/DESIGN.md §13 for the layout.
 *
 * Writes are create-only except HEAD; nothing is ever deleted (unreferenced objects of interrupted commits are
 * harmless and reported by "Verify repository"). Content-addressed records are verified by their hash on read.
 */
export class ObjectStoreRepository implements RemoteRepository {
  private readonly verifyDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly concurrency: number;
  /** Blob ids uploaded through this instance (valid `putUploadedObject` handles without another request). */
  private readonly uploaded = new Set<string>();

  constructor(
    readonly store: BlobStore,
    private readonly o: ObjectStoreOptions,
  ) {
    this.verifyDelayMs = o.verifyDelayMs ?? 1500;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o.now ?? (() => Date.now());
    this.concurrency = Math.max(1, Math.floor(o.concurrency ?? 6));
  }

  // ───────────────────────── head ─────────────────────────

  async getHead(): Promise<HeadState> {
    const head = await this.readHead();
    if (head) {
      await this.assertOurLayout();
      return { kind: "ok", commit: head.record.commit };
    }
    // A claimed location without HEAD: a setup that never finished, or HEAD was lost.
    return (await this.readMarker()) === "absent" ? { kind: "empty" } : { kind: "branchMissing" };
  }

  private async readHead(): Promise<{ record: HeadRecord; etag: string | null } | null> {
    const stored = await this.store.get("HEAD", MAX_HEAD_BYTES);
    return stored ? { record: parseHead(stored.bytes), etag: stored.etag } : null;
  }

  private async readMarker(): Promise<"absent" | "ours" | "newer" | "foreign"> {
    try {
      const stored = await this.store.get("vault.json", MAX_MARKER_BYTES);
      return stored ? parseMarker(stored.bytes) : "absent";
    } catch (error: unknown) {
      if (error instanceof RemoteError && error.category === "PayloadTooLarge") return "foreign";
      throw error;
    }
  }

  /** A store written by a newer plugin version (or something else) is never read or written as ours. */
  private async assertOurLayout(): Promise<void> {
    if (markedStores.has(this.store.id)) return;
    const marker = await this.readMarker();
    if (marker === "newer") throw SyncError.blocked("UnknownFormatVersion");
    if (marker !== "ours") throw SyncError.blocked("RepositoryNotEmpty");
    markedStores.add(this.store.id);
  }

  /** Once per session and store before the first write: compare-and-swap must really work here. */
  private async assertCapable(): Promise<void> {
    if (this.o.skipProbe || probedStores.has(this.store.id)) return;
    await probeStore(this.store, this.o.crypto);
    probedStores.add(this.store.id);
  }

  // ───────────────────────── reads ─────────────────────────

  async readConfig(commit: string): Promise<Uint8Array | null> {
    return this.blob((await this.commit(commit)).config);
  }

  async readManifest(commit: string): Promise<Uint8Array | null> {
    const record = await this.commit(commit);
    return record.manifest === null ? null : this.blob(record.manifest);
  }

  async readObject(commit: string, objectId: string): Promise<Uint8Array> {
    const leaf = await this.leaf(await this.commit(commit), objectId);
    if (!leaf || leaf.b === null) throw new RemoteError("NotFound", 404);
    return this.blob(leaf.b);
  }

  async listObjectRevisions(from: string, objectId: string, limit: number): Promise<ObjectRevision[]> {
    const leaf = await this.leaf(await this.commit(from), objectId);
    if (!leaf) return [];
    const out: Revision[] = [...leaf.r];
    let page = leaf.o;
    while (page && out.length < limit) {
      const p = await this.page(page);
      out.push(...p.e);
      page = p.n;
    }
    return out.slice(0, limit).map((r) => ({ commit: r.c, date: r.t, device: r.d, migration: r.m === 1 }));
  }

  async listObjectIds(commit: string): Promise<{ ids: string[]; complete: boolean }> {
    const root = await this.root((await this.commit(commit)).root);
    const ids: string[] = [];
    for (const [bucket, subId] of Object.entries(root.f)) {
      const sub = await this.sub(subId, bucket);
      for (const [id, leaf] of Object.entries(sub.e)) if (leaf.b !== null) ids.push(id);
    }
    return { ids: ids.sort(), complete: true };
  }

  async isBootstrapCommit(commit: string): Promise<boolean> {
    const record = await this.commit(commit);
    return record.manifest === null && Object.keys((await this.root(record.root)).f).length === 0;
  }

  async hasAnyFiles(): Promise<boolean> {
    return true; // every commit carries at least the config
  }

  async getParents(commit: string): Promise<string[]> {
    const record = await this.commit(commit);
    return record.parent ? [record.parent] : [];
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    const a = await this.commitOrNull(ancestor);
    const d = await this.commitOrNull(descendant);
    if (!a || !d || a.seq >= d.seq) return false;
    const found = await this.walkToSeq(d, a.seq);
    return found !== null && found.id === a.id;
  }

  /**
   * The ancestor of `from` with sequence `seq`, via skip pointers (O(log² n) requests). Every link must have
   * exactly the sequence it claims; an inconsistent chain yields null (never a wrong answer).
   */
  private async walkToSeq(from: CommitRecord, seq: number): Promise<CommitRecord | null> {
    let current = from;
    for (let steps = 0; current.seq > seq; steps++) {
      if (steps > MAX_ANCESTRY_STEPS) return null;
      const skipSeq = skipTarget(current.seq);
      const useSkip = current.skip !== null && skipSeq >= seq;
      const nextId = useSkip ? current.skip : current.parent;
      if (!nextId) return null;
      const next = await this.commitOrNull(nextId);
      if (!next || next.seq !== (useSkip ? skipSeq : current.seq - 1)) return null;
      current = next;
    }
    return current.seq === seq ? current : null;
  }

  // ───────────────────────── writes ─────────────────────────

  async initialize(config: PublicVaultConfig, meta: CommitMetadata): Promise<string> {
    if (!isStoreMessage(meta.message)) throw new SyncError("InvalidState", "unexpected commit message");
    if (await this.store.get("HEAD", MAX_HEAD_BYTES)) throw new SyncError("ConcurrentRemoteUpdate");
    await this.assertClaimable();
    await this.assertCapable();
    if ((await this.store.create("vault.json", encodeMarker())) === "exists" && (await this.readMarker()) !== "ours") {
      throw SyncError.blocked("RepositoryNotEmpty");
    }
    const configId = await this.putBlob(serializeVaultConfig(config));
    const rootId = await this.putTree(encodeRoot(EMPTY_ROOT));
    const id = this.newCommitId();
    await this.putCommit({ id, parent: null, skip: null, seq: 0, time: this.now(), message: meta.message, config: configId, manifest: null, root: rootId });
    if ((await this.store.create("HEAD", encodeHead({ commit: id, seq: 0 }))) === "exists") throw new SyncError("ConcurrentRemoteUpdate");
    markedStores.add(this.store.id);
    return id;
  }

  /** Only an empty location, or leftovers of an interrupted setup of this plugin, may be initialised. */
  private async assertClaimable(): Promise<void> {
    const root = await this.store.listChildren("");
    const allowedDirs = new Set(["probe", "commits", "trees", "blobs"]);
    if (root.files.some((f) => f !== "vault.json") || root.dirs.some((d) => !allowedDirs.has(d))) throw SyncError.blocked("RepositoryNotEmpty");
    if (root.files.includes("vault.json")) {
      const marker = await this.readMarker();
      if (marker === "newer") throw SyncError.blocked("UnknownFormatVersion");
      if (marker !== "ours") throw SyncError.blocked("RepositoryNotEmpty");
    }
    // A HEAD-less store with real history is a vault that lost its HEAD – never initialise over it.
    if (root.dirs.includes("commits")) {
      for (const bucket of (await this.store.listChildren("commits")).dirs.slice(0, 50)) {
        for (const file of (await this.store.listChildren(`commits/${bucket}`)).files.slice(0, 50)) {
          const record = await this.commitOrNull(file);
          if (!record || record.seq > 0) throw SyncError.blocked("RepositoryNotEmpty");
        }
      }
    }
  }

  async uploadObject(blob: EncryptedBlob): Promise<string> {
    assertEncrypted(blob.bytes);
    await this.assertCapable();
    const id = await this.putBlob(blob.bytes);
    this.uploaded.add(id);
    return id;
  }

  async createCommit(parent: string, changes: readonly RemoteChange[], meta: CommitMetadata): Promise<string> {
    if (!isStoreMessage(meta.message)) throw new SyncError("InvalidState", "unexpected commit message");
    await this.assertCapable();
    const p = await this.commit(parent);
    const id = this.newCommitId();
    const seq = p.seq + 1;
    const skipAt = await this.walkToSeq(p, skipTarget(seq));
    if (!skipAt) throw new RemoteError("InvalidResponse");

    let config = p.config;
    let manifest = p.manifest;
    const objectBlobs = new Map<string, string | null>();
    const uploads: Array<{ objectId: string; bytes: Uint8Array }> = [];
    const seen = new Set<string>();
    const claim = (objectId: string): void => {
      // One change per object and commit: the order of changes can then never matter.
      if (!HEX_32.test(objectId) || seen.has(objectId)) throw new SyncError("InvalidState", "invalid or duplicate object in one commit");
      seen.add(objectId);
    };
    for (const change of changes) {
      switch (change.kind) {
        case "putObject":
          claim(change.objectId);
          assertEncrypted(change.blob.bytes);
          uploads.push({ objectId: change.objectId, bytes: change.blob.bytes });
          break;
        case "putUploadedObject":
          claim(change.objectId);
          await this.assertUploaded(change.handle);
          objectBlobs.set(change.objectId, change.handle);
          break;
        case "deleteObject":
          claim(change.objectId);
          objectBlobs.set(change.objectId, null);
          break;
        case "putManifest":
          assertEncrypted(change.blob.bytes);
          manifest = await this.putBlob(change.blob.bytes);
          break;
        case "putConfig":
          config = await this.putBlob(serializeVaultConfig(change.config));
          break;
      }
    }
    const uploadedIds = await mapLimit(uploads, this.concurrency, (u) => this.putBlob(u.bytes));
    uploads.forEach((u, i) => objectBlobs.set(u.objectId, uploadedIds[i] as string));

    const rev: Revision = { c: id, t: this.now(), d: parseCommitDevice(meta.message), m: isMigrationMessage(meta.message) ? 1 : 0 };
    const root = await this.root(p.root);
    const f: Record<string, string> = { ...root.f };
    const byBucket = new Map<string, Array<[string, string | null]>>();
    for (const [objectId, blobId] of objectBlobs) {
      const bucket = objectId.slice(0, 2);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), [objectId, blobId]]);
    }
    for (const [bucket, updates] of byBucket) {
      const sub: SubTree = root.f[bucket] ? await this.sub(root.f[bucket] as string, bucket) : { e: {} };
      const e: Record<string, Leaf> = { ...sub.e };
      let changed = false;
      for (const [objectId, blobId] of updates) {
        const leaf = e[objectId];
        // No-ops create no revision (like git): deleting what is absent/deleted, or writing the same blob again.
        if ((blobId === null && (!leaf || leaf.b === null)) || (leaf && leaf.b === blobId)) continue;
        e[objectId] = await this.nextLeaf(leaf, blobId, rev);
        changed = true;
      }
      if (changed) f[bucket] = await this.putTree(encodeSub({ e }));
    }
    const rootId = await this.putTree(encodeRoot({ f }));
    await this.putCommit({ id, parent: p.id, skip: skipAt.id, seq, time: rev.t, message: meta.message, config, manifest, root: rootId });
    return id;
  }

  /** A handle must name a blob that really exists (uploaded here, or checked). */
  private async assertUploaded(handle: string): Promise<void> {
    if (!HEX_64.test(handle)) throw new RemoteError("InvalidResponse");
    if (this.uploaded.has(handle)) return;
    await this.blob(handle);
    this.uploaded.add(handle);
  }

  /** A leaf with a new newest revision; full inline lists move to an immutable page first. */
  private async nextLeaf(leaf: Leaf | undefined, blobId: string | null, rev: Revision): Promise<Leaf> {
    if (!leaf) return { b: blobId, r: [rev], o: null };
    if (leaf.r.length < INLINE_REVISIONS) return { b: blobId, r: [rev, ...leaf.r], o: leaf.o };
    const page = await this.putTree(encodePage({ e: leaf.r, n: leaf.o }));
    return { b: blobId, r: [rev], o: page };
  }

  async updateHead(expectedParent: string, newCommit: string): Promise<void> {
    await this.assertCapable();
    const current = await this.readHead();
    if (!current) throw SyncError.blocked("BranchDeleted");
    if (current.record.commit !== expectedParent) {
      if (await this.landed(newCommit, current.record.commit)) return this.confirmLanded(newCommit);
      throw new SyncError("ConcurrentRemoteUpdate");
    }
    const next = await this.commit(newCommit);
    if (next.parent !== expectedParent || next.seq !== current.record.seq + 1) throw new SyncError("InvalidState", "commit is not a child of the head");
    if (!current.etag) throw new RemoteError("Unsupported");
    let result;
    try {
      result = await this.store.replace("HEAD", encodeHead({ commit: newCommit, seq: next.seq }), current.etag);
    } catch (error: unknown) {
      // Unknown outcome: look at HEAD to decide. Still the old one → the update did not happen (retry later).
      if (!(error instanceof RemoteError) || error.category !== "Network") throw error;
      const after = await this.readHead();
      if (!after || after.record.commit === expectedParent) throw error;
      if (await this.landed(newCommit, after.record.commit)) return this.confirmLanded(newCommit);
      throw new SyncError("ConcurrentRemoteUpdate");
    }
    if (!result.ok) {
      const after = await this.readHead();
      if (after && (await this.landed(newCommit, after.record.commit))) return this.confirmLanded(newCommit);
      throw new SyncError("ConcurrentRemoteUpdate");
    }
    return this.confirmLanded(newCommit);
  }

  /**
   * Every successful path ends here. On stores whose conditional write is not atomic, a simultaneous writer may
   * replace our HEAD right after: nothing counts as landed unless our commit is still part of HEAD a moment later.
   * (A writer that is slower than this window is detected by the next sync: the head is then a sibling of our
   * last commit, which blocks instead of losing anything.)
   */
  private async confirmLanded(commit: string): Promise<void> {
    if (this.store.casAtomic) return;
    await this.sleep(this.verifyDelayMs);
    const after = await this.readHead();
    if (!after || !(await this.landed(commit, after.record.commit))) throw new SyncError("ConcurrentRemoteUpdate");
  }

  private async landed(commit: string, head: string): Promise<boolean> {
    return head === commit || (await this.isAncestor(commit, head));
  }

  // ───────────────────────── helpers ─────────────────────────

  private newCommitId(): string {
    return toHex(this.o.crypto.randomBytes(32));
  }

  private async commit(id: string): Promise<CommitRecord> {
    const record = await this.commitOrNull(id);
    if (!record) throw new RemoteError("NotFound", 404);
    return record;
  }

  private async commitOrNull(id: string): Promise<CommitRecord | null> {
    if (!HEX_64.test(id)) return null;
    const key = `commits/${id.slice(0, 2)}/${id}`;
    const cacheKey = `${this.store.id}|commit|${key}`;
    const hit = sharedCache.get(cacheKey) as CommitRecord | undefined;
    if (hit) return hit;
    const stored = await this.store.get(key, MAX_COMMIT_BYTES);
    if (!stored) return null;
    const record = parseCommit(stored.bytes, id);
    sharedCache.set(cacheKey, record, stored.bytes.length);
    return record;
  }

  private root(id: string): Promise<RootTree> {
    return this.cached("root", "", id, parseRoot);
  }

  private sub(id: string, bucket: string): Promise<SubTree> {
    return this.cached("sub", bucket, id, (bytes) => parseSub(bytes, bucket));
  }

  private page(id: string): Promise<RevPage> {
    return this.cached("page", "", id, parsePage);
  }

  private async leaf(commit: CommitRecord, objectId: string): Promise<Leaf | undefined> {
    if (!HEX_32.test(objectId)) return undefined;
    const bucket = objectId.slice(0, 2);
    const subId = (await this.root(commit.root)).f[bucket];
    return subId ? (await this.sub(subId, bucket)).e[objectId] : undefined;
  }

  /** A content-addressed tree record, hash-verified and cached per kind (and bucket for subtrees). */
  private async cached<T>(kind: string, bucket: string, id: string, parse: (bytes: Uint8Array) => T): Promise<T> {
    if (!HEX_64.test(id)) throw new RemoteError("InvalidResponse");
    const key = `trees/${id.slice(0, 2)}/${id}`;
    const cacheKey = `${this.store.id}|${kind}|${bucket}|${key}`;
    const hit = sharedCache.get(cacheKey) as T | undefined;
    if (hit !== undefined) return hit;
    const bytes = await this.verified(key, MAX_TREE_BYTES, id);
    const value = parse(bytes);
    sharedCache.set(cacheKey, value, bytes.length);
    return value;
  }

  private async blob(id: string): Promise<Uint8Array> {
    if (!HEX_64.test(id)) throw new RemoteError("InvalidResponse");
    return this.verified(`blobs/${id.slice(0, 2)}/${id}`, MAX_BLOB_BYTES, id);
  }

  /** Stored bytes whose hash must equal their key; a mismatch is corrupted content (CryptoError, like GCM). */
  private async verified(key: string, max: number, id: string): Promise<Uint8Array> {
    const stored = await this.store.get(key, max);
    if (!stored) throw new RemoteError("NotFound", 404);
    if ((await this.o.crypto.hash(stored.bytes)) !== id) throw new CryptoError("IntegrityMismatch", "stored object does not match its hash");
    return stored.bytes;
  }

  private async putBlob(bytes: Uint8Array): Promise<string> {
    return this.putAddressed("blobs", bytes, MAX_BLOB_BYTES);
  }

  private async putTree(bytes: Uint8Array): Promise<string> {
    return this.putAddressed("trees", bytes, MAX_TREE_BYTES);
  }

  /**
   * Create-only write of content-addressed bytes. An existing object is fine if it has the right hash; a
   * corrupt one (e.g. a torn upload) is the only thing ever replaced – its correct content is defined by its key.
   */
  private async putAddressed(dir: string, bytes: Uint8Array, max: number): Promise<string> {
    const id = await this.o.crypto.hash(bytes);
    const key = `${dir}/${id.slice(0, 2)}/${id}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await this.store.create(key, bytes)) === "created") return id;
      const existing = await this.store.get(key, max);
      if (!existing) continue; // reported as existing but not readable (yet): try the create once more
      if ((await this.o.crypto.hash(existing.bytes)) === id) return id;
      if (existing.etag && (await this.store.replace(key, bytes, existing.etag)).ok) return id;
      break;
    }
    throw new RemoteError("InvalidResponse");
  }

  private async putCommit(record: CommitRecord): Promise<void> {
    if ((await this.store.create(`commits/${record.id.slice(0, 2)}/${record.id}`, encodeCommit(record))) !== "created") {
      throw new RemoteError("InvalidResponse"); // random 256-bit ids never collide
    }
  }
}

/** Sequence the skip pointer of `seq` points to (lowest set bit cleared). */
function skipTarget(seq: number): number {
  return seq & (seq - 1);
}

/** Runs `fn` over `items` with at most `limit` in flight; stops starting new work after the first failure. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error: unknown) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
