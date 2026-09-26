import { CryptoError } from "../errors/CryptoError";
import { concatBytes, utf8Encode } from "../util/bytes";
import type { CryptoProvider } from "./CryptoProvider";

/**
 * Envelope format v1 (see docs/DESIGN.md §2.2):
 *
 *   0  4  magic "OVSE"
 *   4  1  envelope version (1)
 *   5  1  algorithm (1 = AES-256-GCM)
 *   6  1  kind (1 object, 2 manifest, 3 key slot)
 *   7  1  reserved (0)
 *   8  12 nonce
 *   20 n  ciphertext || 16 byte GCM tag
 *
 * AAD = bytes[0..8) || UTF-8(context). The nonce is authenticated by GCM itself.
 */

export const ENVELOPE_MAGIC = Object.freeze([0x4f, 0x56, 0x53, 0x45]);
export const ENVELOPE_VERSION = 1;
export const HEADER_PREFIX_LENGTH = 8;
export const NONCE_LENGTH = 12;
export const HEADER_LENGTH = HEADER_PREFIX_LENGTH + NONCE_LENGTH;
export const TAG_LENGTH = 16;
export const MIN_ENVELOPE_LENGTH = HEADER_LENGTH + TAG_LENGTH;
/** Bytes an envelope adds to its plaintext. */
export const ENVELOPE_OVERHEAD = MIN_ENVELOPE_LENGTH;

export enum AlgorithmId {
  Aes256Gcm = 1,
}

export enum EnvelopeKind {
  Object = 1,
  Manifest = 2,
  KeySlot = 3,
}

export interface ParsedEnvelope {
  readonly version: number;
  readonly algorithm: AlgorithmId;
  readonly kind: EnvelopeKind;
  readonly headerPrefix: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

const SEAL = Symbol("EncryptedBlob.seal");

/**
 * The only type the remote layer accepts for object/manifest uploads. Instances can only be created
 * by {@link sealEnvelope} in this module, i.e. only as the result of an encryption. This makes a
 * "vault file → GitHub API" code path a type error.
 */
export class EncryptedBlob {
  readonly #bytes: Uint8Array;
  readonly kind: EnvelopeKind;

  private constructor(bytes: Uint8Array, kind: EnvelopeKind) {
    this.#bytes = bytes;
    this.kind = kind;
  }

  /** @internal Only callable with the module-private seal token. */
  static fromSealed(token: symbol, bytes: Uint8Array, kind: EnvelopeKind): EncryptedBlob {
    if (token !== SEAL) throw new CryptoError("InvalidInput", "EncryptedBlob can only be created by encryption");
    assertEnvelopeHeader(bytes);
    return new EncryptedBlob(bytes, kind);
  }

  get bytes(): Uint8Array {
    return this.#bytes;
  }

  get length(): number {
    return this.#bytes.length;
  }
}

export function buildHeaderPrefix(kind: EnvelopeKind, algorithm: AlgorithmId = AlgorithmId.Aes256Gcm): Uint8Array {
  return new Uint8Array([...ENVELOPE_MAGIC, ENVELOPE_VERSION, algorithm, kind, 0]);
}

/** Cheap structural check (magic, version, algorithm, kind, minimal length). Not a security check. */
export function isEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_ENVELOPE_LENGTH) return false;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) if (bytes[i] !== ENVELOPE_MAGIC[i]) return false;
  return (
    bytes[4] === ENVELOPE_VERSION &&
    bytes[5] === AlgorithmId.Aes256Gcm &&
    (bytes[6] === EnvelopeKind.Object || bytes[6] === EnvelopeKind.Manifest || bytes[6] === EnvelopeKind.KeySlot) &&
    bytes[7] === 0
  );
}

export function assertEnvelopeHeader(bytes: Uint8Array): void {
  if (!isEnvelope(bytes)) throw new CryptoError("InvalidInput", "not an encrypted envelope");
}

export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (bytes.length < 4) throw new CryptoError("UnsupportedFormat", "too short");
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) throw new CryptoError("UnsupportedFormat", "magic");
  }
  if (bytes.length < HEADER_PREFIX_LENGTH) throw new CryptoError("UnsupportedFormat", "too short");
  const version = bytes[4] as number;
  if (version !== ENVELOPE_VERSION) throw new CryptoError("UnsupportedFormat", `envelope version ${version}`);
  const algorithm = bytes[5] as number;
  if (algorithm !== AlgorithmId.Aes256Gcm) throw new CryptoError("UnsupportedFormat", `algorithm ${algorithm}`);
  const kind = bytes[6] as number;
  if (kind !== EnvelopeKind.Object && kind !== EnvelopeKind.Manifest && kind !== EnvelopeKind.KeySlot) {
    throw new CryptoError("UnsupportedFormat", `kind ${kind}`);
  }
  if (bytes[7] !== 0) throw new CryptoError("UnsupportedFormat", "reserved byte");
  if (bytes.length < MIN_ENVELOPE_LENGTH) throw new CryptoError("DecryptionFailed", "truncated");
  return {
    version,
    algorithm,
    kind,
    headerPrefix: bytes.subarray(0, HEADER_PREFIX_LENGTH),
    nonce: bytes.subarray(HEADER_PREFIX_LENGTH, HEADER_LENGTH),
    ciphertext: bytes.subarray(HEADER_LENGTH),
  };
}

export const Contexts = {
  object: (vaultId: string, objectId: string): string => `ovs/v1/object/${vaultId}/${objectId}`,
  manifest: (vaultId: string): string => `ovs/v1/manifest/${vaultId}`,
  keySlot: (vaultId: string, slotId: string, canonicalKdf: string): string => `ovs/v1/keyslot/${vaultId}/${slotId}/${canonicalKdf}`,
} as const;

function associatedData(headerPrefix: Uint8Array, context: string): Uint8Array {
  return concatBytes(headerPrefix, utf8Encode(context));
}

/** Encrypts plaintext into a v1 envelope. */
export async function sealEnvelope(
  crypto: CryptoProvider,
  key: CryptoKey,
  kind: EnvelopeKind,
  plaintext: Uint8Array,
  context: string,
): Promise<EncryptedBlob> {
  const headerPrefix = buildHeaderPrefix(kind);
  const encrypted = await crypto.encrypt(plaintext, key, associatedData(headerPrefix, context));
  if (encrypted.algorithm !== "AES-256-GCM" || encrypted.nonce.length !== NONCE_LENGTH) {
    throw new CryptoError("InvalidInput", "provider returned unexpected parameters");
  }
  const bytes = new Uint8Array(HEADER_LENGTH + encrypted.ciphertext.length);
  bytes.set(headerPrefix, 0);
  bytes.set(encrypted.nonce, HEADER_PREFIX_LENGTH);
  bytes.set(encrypted.ciphertext, HEADER_LENGTH);
  return EncryptedBlob.fromSealed(SEAL, bytes, kind);
}

/** Verifies and decrypts an envelope. Throws; never returns unauthenticated data. */
export async function openEnvelope(
  crypto: CryptoProvider,
  key: CryptoKey,
  expectedKind: EnvelopeKind,
  bytes: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  const parsed = parseEnvelope(bytes);
  if (parsed.kind !== expectedKind) throw new CryptoError("DecryptionFailed", "unexpected envelope kind");
  return crypto.decrypt(
    { algorithm: "AES-256-GCM", nonce: parsed.nonce, ciphertext: parsed.ciphertext },
    key,
    associatedData(parsed.headerPrefix, context),
  );
}
