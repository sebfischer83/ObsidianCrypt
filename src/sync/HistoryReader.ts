import type { EncryptionEngine } from "../crypto/EncryptionEngine";
import { SyncError } from "../errors/SyncError";
import type { Manifest } from "../manifest/Manifest";
import { decodeManifest } from "../manifest/ManifestCodec";
import type { RemoteRepository } from "../remote/RemoteRepository";

/** Decrypted, strictly validated manifest at any commit of the history (authenticated by AES-GCM). */
export async function readManifestAt(remote: RemoteRepository, engine: EncryptionEngine, commit: string): Promise<Manifest> {
  const bytes = await remote.readManifest(commit);
  if (!bytes) throw SyncError.blocked("ManifestMissing");
  let plaintext: Uint8Array;
  try {
    plaintext = await engine.decryptManifest(bytes);
  } catch (error: unknown) {
    throw SyncError.blocked("ManifestCorrupted", { cause: error });
  }
  return decodeManifest(plaintext, engine.vaultId);
}
