import type { CryptoProvider } from "../crypto/CryptoProvider";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import type { VaultKeys } from "../crypto/KeyManager";
import { SyncError } from "../errors/SyncError";
import { emptyManifest, type Manifest } from "../manifest/Manifest";
import { parseVaultConfig, serializeVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
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

/** SHA-256 of a serialised config as recorded in `manifest.configHash`. */
export function configHashOf(crypto: CryptoProvider, config: PublicVaultConfig | Uint8Array): Promise<string> {
  return crypto.hash(config instanceof Uint8Array ? config : serializeVaultConfig(config));
}

/** Throws unless the manifest (if it records one) was written for exactly this config. */
export async function checkConfigBinding(crypto: CryptoProvider, manifest: Manifest, configBytes: Uint8Array): Promise<void> {
  if (manifest.configHash !== undefined && manifest.configHash !== (await configHashOf(crypto, configBytes))) throw SyncError.blocked("ConfigCorrupted");
}

/** Parses the public config and checks size, vault id and MAC. */
export async function verifiedConfig(crypto: CryptoProvider, keys: VaultKeys, bytes: Uint8Array): Promise<PublicVaultConfig> {
  const config = parseVaultConfig(bytes);
  if (config.vaultId !== keys.vaultId) throw SyncError.blocked("ForeignVault");
  if (!(await keys.verifyConfigMac(crypto, config))) throw SyncError.blocked("ConfigCorrupted");
  return config;
}

/** How far back {@link descendsFrom} follows manifests before trusting the backend's ancestry answer. */
export const MAX_CHAIN_STEPS = 25;

/**
 * True if `head` (whose authenticated manifest is `headManifest`) was built on top of `ancestor`, the commit of
 * a manifest with version `ancestorVersion`. Follows the encrypted `parentCommit` links – which nobody without
 * the vault key can forge – back to `ancestor`, requiring the version to drop by exactly one per commit. Only
 * after MAX_CHAIN_STEPS (a device that was offline for a long time) the backend's compare answer is used.
 */
export async function descendsFrom(
  remote: RemoteRepository,
  engine: EncryptionEngine,
  head: string,
  headManifest: Manifest,
  ancestor: string,
  ancestorVersion: number,
): Promise<boolean> {
  if (head === ancestor) return headManifest.version === ancestorVersion;
  let manifest = headManifest;
  for (let step = 0; ; step++) {
    const parent = manifest.parentCommit;
    if (parent === null) return false;
    // A bootstrap commit (version 0, no manifest) can be followed by any version (a moved vault starts higher).
    if (parent === ancestor) return manifest.version === ancestorVersion + 1 || (ancestorVersion === 0 && manifest.version > 0);
    // Versions drop by one per step: once at ancestorVersion + 1 the ancestor can no longer be reached.
    if (manifest.version <= ancestorVersion + 1) return false;
    if (step >= MAX_CHAIN_STEPS) return remote.isAncestor(ancestor, head);
    let parentManifest: Manifest;
    try {
      parentManifest = await readManifestAt(remote, engine, parent);
    } catch (error: unknown) {
      if (error instanceof SyncError && (error.blockReason === "ManifestMissing" || error.blockReason === "ManifestCorrupted")) return false;
      throw error;
    }
    if (parentManifest.version !== manifest.version - 1) return false;
    manifest = parentManifest;
  }
}

export interface VerifiedHead {
  readonly commit: string;
  readonly config: PublicVaultConfig;
  /** SHA-256 of the config bytes as stored at this commit (what `manifest.configHash` must equal). */
  readonly configHash: string;
  readonly manifest: Manifest;
}

/**
 * The current head of a repository, fully authenticated: config MAC with this vault's key, manifest
 * decrypted and validated, bound to its position in the history (manifest.parentCommit is the head's only
 * parent) and to the config (manifest.configHash). A repository still at its bootstrap commit yields an
 * empty manifest.
 */
export async function readVerifiedHead(remote: RemoteRepository, crypto: CryptoProvider, keys: VaultKeys, deviceId: string): Promise<VerifiedHead> {
  const head = await remote.getHead();
  if (head.kind !== "ok") throw new SyncError("NotConfigured", "remote branch not initialised");
  const configBytes = await remote.readConfig(head.commit);
  if (!configBytes) throw SyncError.blocked("ConfigMissing");
  const config = await verifiedConfig(crypto, keys, configBytes);
  if (!(await remote.readManifest(head.commit))) {
    if (!(await remote.isBootstrapCommit(head.commit))) throw SyncError.blocked("ManifestMissing");
    return { commit: head.commit, config, configHash: await configHashOf(crypto, configBytes), manifest: emptyManifest(keys.vaultId, deviceId) };
  }
  const manifest = await readManifestAt(remote, new EncryptionEngine(crypto, keys), head.commit);
  const parents = await remote.getParents(head.commit);
  if (parents.length !== 1 || parents[0] !== manifest.parentCommit) throw SyncError.blocked("HistoryRewritten");
  await checkConfigBinding(crypto, manifest, configBytes);
  return { commit: head.commit, config, configHash: await configHashOf(crypto, configBytes), manifest };
}
