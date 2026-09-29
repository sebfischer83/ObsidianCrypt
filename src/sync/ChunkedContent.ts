import type { EncryptionEngine } from "../crypto/EncryptionEngine";
import { ENVELOPE_OVERHEAD, envelopeKind, EnvelopeKind } from "../crypto/EncryptionFormat";
import { CryptoError } from "../errors/CryptoError";
import type { LiveEntry } from "../manifest/Manifest";
import { MAX_CHUNKS } from "../manifest/ManifestCodec";
import type { RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { canonicalJson } from "../util/canonicalJson";
import { expectArray, expectInteger, expectLiteral, expectOnlyKeys, expectRecord, expectString, HEX_32, HEX_64 } from "../util/validate";

/**
 * Large files (manifest formatVersion 2, docs/DESIGN.md §2.5): the plaintext is split into fixed-size chunks.
 * Every chunk is an ordinary encrypted object with its own random id; the file's own object id holds an
 * encrypted chunk index (envelope kind 4) listing chunk ids, sizes and plaintext hashes. Fixed-size chunks
 * reveal nothing but the total size (already visible); random ids reveal no equality between files.
 */

export const CHUNK_INDEX_TYPE = "obsidian-encrypted-sync-chunks";
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
/** Upper bound for an encrypted chunk index (MAX_CHUNKS entries of about 120 bytes). */
const MAX_INDEX_ENVELOPE_BYTES = 16 * 1024 * 1024;

export interface ChunkRef {
  readonly id: string;
  readonly size: number;
  /** SHA-256 (hex) of the chunk plaintext. */
  readonly hash: string;
}

export function encodeChunkIndex(chunks: readonly ChunkRef[]): Uint8Array {
  return utf8Encode(canonicalJson({ type: CHUNK_INDEX_TYPE, chunks: chunks.map((c) => ({ id: c.id, size: c.size, hash: c.hash })) }));
}

/** Strict parser. Any structural problem is an integrity failure (the index was authenticated before). */
export function decodeChunkIndex(bytes: Uint8Array): ChunkRef[] {
  try {
    const record = expectRecord(JSON.parse(utf8Decode(bytes)), "chunks");
    expectOnlyKeys(record, ["type", "chunks"], "chunks");
    expectLiteral(record.type, CHUNK_INDEX_TYPE, "chunks.type");
    const list = expectArray(record.chunks, "chunks.chunks");
    if (list.length === 0 || list.length > MAX_CHUNKS) throw new Error("chunk count");
    const seen = new Set<string>();
    return list.map((value, i) => {
      const c = expectRecord(value, `chunks.${i}`);
      expectOnlyKeys(c, ["id", "size", "hash"], `chunks.${i}`);
      const id = expectString(c.id, `chunks.${i}.id`, HEX_32);
      if (seen.has(id)) throw new Error("duplicate chunk id");
      seen.add(id);
      return { id, size: expectInteger(c.size, `chunks.${i}.size`, 1), hash: expectString(c.hash, `chunks.${i}.hash`, HEX_64) };
    });
  } catch (error: unknown) {
    throw new CryptoError("IntegrityMismatch", "invalid chunk index", { cause: error });
  }
}

/**
 * Plaintext of an object at a commit, following a chunk index if the object is one. With `expectedHash`
 * (from the manifest) the complete content is verified against it; without (history versions) AES-GCM and
 * the authenticated chunk hashes still guarantee authenticity. Never returns partially verified data.
 */
export async function readObjectContent(
  remote: RemoteRepository,
  engine: EncryptionEngine,
  commit: string,
  objectId: string,
  expectedHash: string | null,
  maxSize = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const envelope = await remote.readObject(commit, objectId);
  if (envelopeKind(envelope) !== EnvelopeKind.ChunkIndex) {
    // Size limits are checked before decrypting (a hostile repository could store huge blobs).
    if (envelope.length > maxSize + ENVELOPE_OVERHEAD) throw new CryptoError("IntegrityMismatch", "object larger than allowed");
    return expectedHash === null ? engine.decryptObjectRevision(objectId, envelope) : engine.decryptObject(objectId, envelope, expectedHash);
  }
  if (envelope.length > MAX_INDEX_ENVELOPE_BYTES) throw new CryptoError("IntegrityMismatch", "chunk index larger than allowed");
  const chunks = decodeChunkIndex(await engine.decryptChunkIndex(objectId, envelope));
  const total = chunks.reduce((sum, c) => sum + c.size, 0);
  if (total > maxSize) throw new CryptoError("IntegrityMismatch", "chunked object larger than allowed");
  const out = new Uint8Array(total);
  let offset = 0;
  try {
    for (const chunk of chunks) {
      const chunkEnvelope = await remote.readObject(commit, chunk.id);
      if (chunkEnvelope.length !== chunk.size + ENVELOPE_OVERHEAD) throw new CryptoError("IntegrityMismatch", "chunk size");
      const data = await engine.decryptObjectRevision(chunk.id, chunkEnvelope);
      if (data.length !== chunk.size || (await engine.hash(data)) !== chunk.hash) throw new CryptoError("IntegrityMismatch", "chunk");
      out.set(data, offset);
      offset += data.length;
    }
    if (expectedHash !== null && (await engine.hash(out)) !== expectedHash) throw new CryptoError("IntegrityMismatch");
  } catch (error: unknown) {
    out.fill(0);
    throw error;
  }
  return out;
}

/** Chunk list of an object that must be a chunk index. */
export async function readChunkIndex(remote: RemoteRepository, engine: EncryptionEngine, commit: string, objectId: string): Promise<ChunkRef[]> {
  const envelope = await remote.readObject(commit, objectId);
  if (envelopeKind(envelope) !== EnvelopeKind.ChunkIndex) throw new CryptoError("IntegrityMismatch", "expected a chunk index");
  if (envelope.length > MAX_INDEX_ENVELOPE_BYTES) throw new CryptoError("IntegrityMismatch", "chunk index larger than allowed");
  return decodeChunkIndex(await engine.decryptChunkIndex(objectId, envelope));
}

export interface EncodeOptions {
  readonly remote: RemoteRepository;
  readonly engine: EncryptionEngine;
  readonly chunkSize: number;
  readonly newChunkId: () => string;
}

export interface EncodedObject {
  readonly changes: RemoteChange[];
  /** Chunk count for the manifest entry, undefined for a single object. */
  readonly chunks: number | undefined;
  /** Chunks actually uploaded (unchanged ones are reused). */
  readonly uploadedChunks: number;
}

/**
 * Remote changes for a new version of an object. Files up to `chunkSize` become one object. Larger files
 * are chunked: changed chunks are uploaded one at a time (bounded memory, not yet committed), chunks equal
 * to the same position of the previous version are reused, obsolete ones are removed from the tree (they
 * stay in the history).
 */
export async function encodeObject(o: EncodeOptions, objectId: string, data: Uint8Array, previous: readonly ChunkRef[] | null): Promise<EncodedObject> {
  const changes: RemoteChange[] = [];
  const kept = new Set<string>();
  const refs: ChunkRef[] = [];
  let uploadedChunks = 0;
  if (data.length > o.chunkSize) {
    for (let offset = 0, index = 0; offset < data.length; offset += o.chunkSize, index++) {
      const piece = data.slice(offset, Math.min(offset + o.chunkSize, data.length));
      const hash = await o.engine.hash(piece);
      const old = previous?.[index];
      if (old && old.size === piece.length && old.hash === hash && !kept.has(old.id)) {
        kept.add(old.id);
        refs.push(old);
        continue;
      }
      const id = o.newChunkId();
      const handle = await o.remote.uploadObject(await o.engine.encryptObject(id, piece));
      changes.push({ kind: "putUploadedObject", objectId: id, handle });
      refs.push({ id, size: piece.length, hash });
      uploadedChunks++;
    }
  }
  for (const old of previous ?? []) if (!kept.has(old.id)) changes.push({ kind: "deleteObject", objectId: old.id });
  if (refs.length === 0) {
    changes.push({ kind: "putObject", objectId, blob: await o.engine.encryptObject(objectId, data) });
    return { changes, chunks: undefined, uploadedChunks };
  }
  changes.push({ kind: "putObject", objectId, blob: await o.engine.encryptChunkIndex(objectId, encodeChunkIndex(refs)) });
  return { changes, chunks: refs.length, uploadedChunks };
}

/** The entry with the given chunk count (undefined = single object). */
export function withChunks(entry: LiveEntry, chunks: number | undefined): LiveEntry {
  const { chunks: _previous, ...rest } = entry;
  return chunks === undefined ? rest : { ...rest, chunks };
}
