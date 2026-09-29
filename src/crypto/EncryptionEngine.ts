import { CryptoError } from "../errors/CryptoError";
import type { CryptoProvider } from "./CryptoProvider";
import { Contexts, EncryptedBlob, EnvelopeKind, openEnvelope, sealEnvelope } from "./EncryptionFormat";
import type { VaultKeys } from "./KeyManager";

const OBJECT_ID = /^[0-9a-f]{32}$/;

/** Upper bound for an encrypted manifest (roughly 400 000 files). */
export const MAX_MANIFEST_ENVELOPE_BYTES = 128 * 1024 * 1024;

/**
 * The single gateway between plaintext and the remote layer. Everything uploaded passes through here.
 */
export class EncryptionEngine {
  constructor(
    private readonly crypto: CryptoProvider,
    private readonly keys: VaultKeys,
  ) {}

  get vaultId(): string {
    return this.keys.vaultId;
  }

  async encryptObject(objectId: string, plaintext: Uint8Array): Promise<EncryptedBlob> {
    assertObjectId(objectId);
    return sealEnvelope(this.crypto, this.keys.objectKey, EnvelopeKind.Object, plaintext, Contexts.object(this.keys.vaultId, objectId));
  }

  /**
   * Decrypts an object and verifies that its plaintext hash equals the hash recorded in the manifest.
   * Returns only fully authenticated data.
   */
  async decryptObject(objectId: string, envelope: Uint8Array, expectedContentHash: string): Promise<Uint8Array> {
    assertObjectId(objectId);
    const plaintext = await openEnvelope(
      this.crypto,
      this.keys.objectKey,
      EnvelopeKind.Object,
      envelope,
      Contexts.object(this.keys.vaultId, objectId),
    );
    const actual = await this.crypto.hash(plaintext);
    if (actual !== expectedContentHash) {
      plaintext.fill(0);
      throw new CryptoError("IntegrityMismatch");
    }
    return plaintext;
  }

  /**
   * Decrypts an older version of an object from the remote history. No manifest hash is available for
   * it; AES-GCM with the vault and object id in the AAD still guarantees that the content was encrypted
   * with this vault's key for exactly this object.
   */
  async decryptObjectRevision(objectId: string, envelope: Uint8Array): Promise<Uint8Array> {
    assertObjectId(objectId);
    return openEnvelope(this.crypto, this.keys.objectKey, EnvelopeKind.Object, envelope, Contexts.object(this.keys.vaultId, objectId));
  }

  /** The chunk list of a large file, stored at the file's own object id (manifest formatVersion 2). */
  async encryptChunkIndex(objectId: string, plaintext: Uint8Array): Promise<EncryptedBlob> {
    assertObjectId(objectId);
    return sealEnvelope(this.crypto, this.keys.objectKey, EnvelopeKind.ChunkIndex, plaintext, Contexts.chunkIndex(this.keys.vaultId, objectId));
  }

  async decryptChunkIndex(objectId: string, envelope: Uint8Array): Promise<Uint8Array> {
    assertObjectId(objectId);
    return openEnvelope(this.crypto, this.keys.objectKey, EnvelopeKind.ChunkIndex, envelope, Contexts.chunkIndex(this.keys.vaultId, objectId));
  }

  async encryptManifest(plaintext: Uint8Array): Promise<EncryptedBlob> {
    return sealEnvelope(this.crypto, this.keys.manifestKey, EnvelopeKind.Manifest, plaintext, Contexts.manifest(this.keys.vaultId));
  }

  async decryptManifest(envelope: Uint8Array): Promise<Uint8Array> {
    // Bounded before any work: a hostile repository must not make a device decrypt and parse gigabytes.
    if (envelope.length > MAX_MANIFEST_ENVELOPE_BYTES) throw new CryptoError("IntegrityMismatch", "manifest larger than allowed");
    return openEnvelope(this.crypto, this.keys.manifestKey, EnvelopeKind.Manifest, envelope, Contexts.manifest(this.keys.vaultId));
  }

  hash(data: Uint8Array): Promise<string> {
    return this.crypto.hash(data);
  }
}

function assertObjectId(objectId: string): void {
  if (!OBJECT_ID.test(objectId)) throw new CryptoError("InvalidInput", "object id");
}
