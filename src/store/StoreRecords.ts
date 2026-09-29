import { RemoteError } from "../errors/RemoteError";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { canonicalJson } from "../util/canonicalJson";
import { expectArray, expectInteger, expectLiteral, expectOnlyKeys, expectRecord, expectString, HEX_32, HEX_64 } from "../util/validate";

/**
 * Records of the object-store layout (docs/DESIGN.md §13). All JSON is canonical and parsed strictly; any
 * structural problem is an InvalidResponse (the store is not trusted, integrity comes from the encrypted
 * manifest chain on top).
 *
 *   vault.json            create-only  StoreMarker
 *   HEAD                  CAS          HeadRecord
 *   commits/<aa>/<id>     create-only  CommitRecord (random id)
 *   trees/<aa>/<sha256>   create-only  RootTree | SubTree | RevPage (content addressed)
 *   blobs/<aa>/<sha256>   create-only  envelopes and the serialised public config (content addressed)
 */

export const STORE_TYPE = "obsidian-crypt-store";
export const STORE_LAYOUT = 1;
/** Revisions kept inline per object before they move to an immutable page. */
export const INLINE_REVISIONS = 8;
/** Sequence numbers stay within 31 bits (the skip pointer uses 32-bit bit operations). */
export const MAX_SEQ = 2 ** 31 - 1;

export interface HeadRecord {
  readonly commit: string;
  readonly seq: number;
}

export interface CommitRecord {
  readonly id: string;
  readonly parent: string | null;
  /** Ancestor at sequence `seq & (seq - 1)` (skip list for fast ancestry checks); null for the root. */
  readonly skip: string | null;
  readonly seq: number;
  readonly time: number;
  readonly message: string;
  readonly config: string;
  readonly manifest: string | null;
  readonly root: string;
}

export interface Revision {
  /** Commit that wrote (or removed) the object. */
  readonly c: string;
  readonly t: number;
  readonly d: string | null;
  /** 1 = written by a vault migration. */
  readonly m: 0 | 1;
}

export interface Leaf {
  /** Current blob, null if the object was deleted in the newest revision. */
  readonly b: string | null;
  /** Newest revisions first (at most INLINE_REVISIONS). */
  readonly r: readonly Revision[];
  /** Older revisions (a RevPage), or null. */
  readonly o: string | null;
}

export interface RootTree {
  readonly f: Readonly<Record<string, string>>;
}

export interface SubTree {
  readonly e: Readonly<Record<string, Leaf>>;
}

export interface RevPage {
  readonly e: readonly Revision[];
  readonly n: string | null;
}

/** Commit messages are free text only in git; here only the plugin's own fixed forms are stored. */
const MESSAGE =
  /^(Encrypted vault sync: \d{1,7} changes?|Encrypted vault migration: \d{1,7} changes?|Encrypted vault moved|Encrypted vault key update|Initialize encrypted vault( \(moved\))?)\n\nDevice: [0-9a-f-]{36}\n$/;
const DEVICE = /^[0-9a-f-]{36}$/;
const BUCKET = /^[0-9a-f]{2}$/;

export function isStoreMessage(message: string): boolean {
  return MESSAGE.test(message);
}

export function encodeRecord(value: unknown): Uint8Array {
  return utf8Encode(canonicalJson(value));
}

function parse(bytes: Uint8Array, what: string): Record<string, unknown> {
  try {
    return expectRecord(JSON.parse(utf8Decode(bytes)), what);
  } catch (error: unknown) {
    throw new RemoteError("InvalidResponse", null, null, { cause: error });
  }
}

function strict<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error: unknown) {
    throw error instanceof RemoteError ? error : new RemoteError("InvalidResponse", null, null, { cause: error });
  }
}

export function encodeMarker(): Uint8Array {
  return encodeRecord({ type: STORE_TYPE, layout: STORE_LAYOUT });
}

/** The marker of this plugin's layout; a newer layout blocks instead of being misread. */
export function parseMarker(bytes: Uint8Array): "ours" | "newer" | "foreign" {
  let r: Record<string, unknown>;
  try {
    r = parse(bytes, "marker");
  } catch {
    return "foreign";
  }
  if (r.type !== STORE_TYPE || typeof r.layout !== "number") return "foreign";
  return r.layout === STORE_LAYOUT ? "ours" : r.layout > STORE_LAYOUT ? "newer" : "foreign";
}

export function encodeHead(h: HeadRecord): Uint8Array {
  return encodeRecord({ type: "ovs-head", v: 1, commit: h.commit, seq: h.seq });
}

export function parseHead(bytes: Uint8Array): HeadRecord {
  const r = parse(bytes, "head");
  return strict("head", () => {
    expectOnlyKeys(r, ["type", "v", "commit", "seq"], "head");
    expectLiteral(r.type, "ovs-head", "head.type");
    expectLiteral(r.v, 1, "head.v");
    return { commit: expectString(r.commit, "head.commit", HEX_64), seq: expectInteger(r.seq, "head.seq", 0, MAX_SEQ) };
  });
}

export function encodeCommit(c: CommitRecord): Uint8Array {
  return encodeRecord({ type: "ovs-commit", v: 1, ...c });
}

export function parseCommit(bytes: Uint8Array, expectedId: string): CommitRecord {
  const r = parse(bytes, "commit");
  return strict("commit", () => {
    expectOnlyKeys(r, ["type", "v", "id", "parent", "skip", "seq", "time", "message", "config", "manifest", "root"], "commit");
    expectLiteral(r.type, "ovs-commit", "commit.type");
    expectLiteral(r.v, 1, "commit.v");
    const id = expectString(r.id, "commit.id", HEX_64);
    if (id !== expectedId) throw new Error("commit id does not match its key");
    const seq = expectInteger(r.seq, "commit.seq", 0, MAX_SEQ);
    const parent = r.parent === null ? null : expectString(r.parent, "commit.parent", HEX_64);
    const skip = r.skip === null ? null : expectString(r.skip, "commit.skip", HEX_64);
    if ((seq === 0) !== (parent === null) || (seq === 0) !== (skip === null)) throw new Error("root commit shape");
    const message = expectString(r.message, "commit.message");
    if (!isStoreMessage(message)) throw new Error("unexpected commit message");
    return {
      id,
      parent,
      skip,
      seq,
      time: expectInteger(r.time, "commit.time", 0),
      message,
      config: expectString(r.config, "commit.config", HEX_64),
      manifest: r.manifest === null ? null : expectString(r.manifest, "commit.manifest", HEX_64),
      root: expectString(r.root, "commit.root", HEX_64),
    };
  });
}

export function encodeRoot(t: RootTree): Uint8Array {
  return encodeRecord({ type: "ovs-root", v: 1, f: t.f });
}

export function parseRoot(bytes: Uint8Array): RootTree {
  const r = parse(bytes, "root");
  return strict("root", () => {
    expectOnlyKeys(r, ["type", "v", "f"], "root");
    expectLiteral(r.type, "ovs-root", "root.type");
    expectLiteral(r.v, 1, "root.v");
    const f: Record<string, string> = {};
    for (const [bucket, id] of Object.entries(expectRecord(r.f, "root.f"))) {
      if (!BUCKET.test(bucket)) throw new Error("bucket");
      f[bucket] = expectString(id, "root.f[]", HEX_64);
    }
    return { f };
  });
}

export function encodeSub(t: SubTree): Uint8Array {
  return encodeRecord({ type: "ovs-sub", v: 1, e: t.e });
}

export function parseSub(bytes: Uint8Array, bucket: string): SubTree {
  const r = parse(bytes, "subtree");
  return strict("subtree", () => {
    expectOnlyKeys(r, ["type", "v", "e"], "subtree");
    expectLiteral(r.type, "ovs-sub", "subtree.type");
    expectLiteral(r.v, 1, "subtree.v");
    const e: Record<string, Leaf> = {};
    for (const [objectId, raw] of Object.entries(expectRecord(r.e, "subtree.e"))) {
      if (!HEX_32.test(objectId) || !objectId.startsWith(bucket)) throw new Error("object id");
      const leaf = expectRecord(raw, "leaf");
      expectOnlyKeys(leaf, ["b", "r", "o"], "leaf");
      const revs = expectArray(leaf.r, "leaf.r").map(parseRevision);
      if (revs.length === 0 || revs.length > INLINE_REVISIONS) throw new Error("revision count");
      e[objectId] = {
        b: leaf.b === null ? null : expectString(leaf.b, "leaf.b", HEX_64),
        r: revs,
        o: leaf.o === null ? null : expectString(leaf.o, "leaf.o", HEX_64),
      };
    }
    return { e };
  });
}

export function encodePage(p: RevPage): Uint8Array {
  return encodeRecord({ type: "ovs-revs", v: 1, e: p.e, n: p.n });
}

export function parsePage(bytes: Uint8Array): RevPage {
  const r = parse(bytes, "page");
  return strict("page", () => {
    expectOnlyKeys(r, ["type", "v", "e", "n"], "page");
    expectLiteral(r.type, "ovs-revs", "page.type");
    expectLiteral(r.v, 1, "page.v");
    const e = expectArray(r.e, "page.e").map(parseRevision);
    if (e.length === 0 || e.length > INLINE_REVISIONS) throw new Error("page size");
    return { e, n: r.n === null ? null : expectString(r.n, "page.n", HEX_64) };
  });
}

function parseRevision(value: unknown): Revision {
  const r = expectRecord(value, "rev");
  expectOnlyKeys(r, ["c", "t", "d", "m"], "rev");
  const m = expectInteger(r.m, "rev.m", 0, 1) as 0 | 1;
  return { c: expectString(r.c, "rev.c", HEX_64), t: expectInteger(r.t, "rev.t", 0), d: r.d === null ? null : expectString(r.d, "rev.d", DEVICE), m };
}
