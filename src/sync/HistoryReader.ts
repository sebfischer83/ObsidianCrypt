import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { SyncError } from "../errors/SyncError";
import { emptyManifest, type Manifest } from "../manifest/Manifest";
import { parseVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
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

export interface VerifiedHead {
  readonly commit: string;
  readonly config: PublicVaultConfig;
  readonly manifest: Manifest;
}

/**
 * The current head of a repository, fully authenticated: config MAC with this vault's key, manifest
 * decrypted and validated, and bound to its position in the history (manifest.parentCommit is the head's
 * only parent). A repository still at its bootstrap commit yields an empty manifest.
 */
export async function readVerifiedHead(remote: RemoteRepository, crypto: CryptoProvider, keys: VaultKeys, deviceId: string): Promise<VerifiedHead> {
  const head = await remote.getHead();
  if (head.kind !== "ok") throw new SyncError("NotConfigured", "remote branch not initialised");
  const configBytes = await remote.readConfig(head.commit);
  if (!configBytes) throw SyncError.blocked("ConfigMissing");
  const config = parseVaultConfig(configBytes);
  if (config.vaultId !== keys.vaultId) throw SyncError.blocked("ForeignVault");
  if (!(await keys.verifyConfigMac(crypto, config))) throw SyncError.blocked("ConfigCorrupted");
  if (!(await remote.readManifest(head.commit))) {
    if (!(await remote.isBootstrapCommit(head.commit))) throw SyncError.blocked("ManifestMissing");
    return { commit: head.commit, config, manifest: emptyManifest(keys.vaultId, deviceId) };
  }
  const manifest = await readManifestAt(remote, new EncryptionEngine(crypto, keys), head.commit);
  const parents = await remote.getParents(head.commit);
  if (parents.length !== 1 || parents[0] !== manifest.parentCommit) throw SyncError.blocked("HistoryRewritten");
  return { commit: head.commit, config, manifest };
}
