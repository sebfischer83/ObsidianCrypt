import type { CryptoProvider } from "../crypto/CryptoProvider";
import type { PasswordKdfAlgorithm } from "../crypto/KeyDerivation";
import {
  changePassword,
  createVault,
  regenerateRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  type VaultKeys,
} from "../crypto/KeyManager";
import { SyncError } from "../errors/SyncError";
import { parseVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
import type { RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import { EncryptionEngine } from "../crypto/EncryptionEngine";
import { formatVersionFor, type Manifest } from "../manifest/Manifest";
import { decodeManifest, encodeManifest } from "../manifest/ManifestCodec";
import { newLocalState } from "../state/LocalState";
import type { SyncStateStore } from "../state/SyncStateStore";
import type { LocalFileSystem } from "../vault/LocalFileSystem";
import type { SyncFilter } from "../vault/SyncFilter";

export type RemoteInspection =
  | { readonly kind: "uninitialized" }
  | { readonly kind: "foreign" }
  | { readonly kind: "vault"; readonly commit: string; readonly config: PublicVaultConfig };

/** Determines whether the configured branch is empty, a foreign repository, or an encrypted vault. */
export async function inspectRemote(remote: RemoteRepository): Promise<RemoteInspection> {
  const head = await remote.getHead();
  if (head.kind !== "ok") return { kind: "uninitialized" };
  const configBytes = await remote.readConfig(head.commit);
  if (!configBytes) return (await remote.hasAnyFiles(head.commit)) ? { kind: "foreign" } : { kind: "uninitialized" };
  return { kind: "vault", commit: head.commit, config: parseVaultConfig(configBytes) };
}

export interface NewVaultResult {
  readonly keys: VaultKeys;
  readonly config: PublicVaultConfig;
  readonly recoveryKey: string | null;
}

/**
 * Creates a new encrypted vault in an empty repository/branch. Never used on a repository that already
 * contains files.
 */
export async function initializeNewVault(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  store: SyncStateStore;
  password: string;
  deviceId: string;
  withRecoveryKey?: boolean;
  kdf?: PasswordKdfAlgorithm;
}): Promise<NewVaultResult> {
  const inspection = await inspectRemote(options.remote);
  if (inspection.kind === "foreign") throw SyncError.blocked("RepositoryNotEmpty");
  if (inspection.kind === "vault") throw new SyncError("InvalidState", "repository already contains an encrypted vault");
  const created = await createVault(options.crypto, options.password, {
    withRecoveryKey: options.withRecoveryKey ?? true,
    ...(options.kdf ? { kdf: options.kdf } : {}),
  });
  await options.remote.initialize(created.config, { message: `Initialize encrypted vault\n\nDevice: ${options.deviceId}\n` });
  const state = newLocalState(options.deviceId);
  state.vaultId = created.config.vaultId;
  options.store.reset(state);
  await options.store.persist();
  return { keys: created.keys, config: created.config, recoveryKey: created.recoveryKey };
}

export type UnlockSecret = { readonly password: string } | { readonly recoveryKey: string };

export async function unlockRemoteVault(crypto: CryptoProvider, config: PublicVaultConfig, secret: UnlockSecret): Promise<VaultKeys> {
  return "password" in secret ? unlockWithPassword(crypto, config, secret.password) : unlockWithRecoveryKey(crypto, config, secret.recoveryKey);
}

/**
 * Connects this device to an existing encrypted vault. The local state starts without merge base, so the
 * first sync never deletes anything: identical files are merged, differing ones become conflict copies.
 */
export async function connectExistingVault(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  store: SyncStateStore;
  secret: UnlockSecret;
  deviceId: string;
}): Promise<{ keys: VaultKeys; config: PublicVaultConfig }> {
  const inspection = await inspectRemote(options.remote);
  if (inspection.kind !== "vault") throw SyncError.blocked("ConfigMissing");
  const keys = await unlockRemoteVault(options.crypto, inspection.config, options.secret);
  const current = options.store.state;
  if (current.vaultId !== inspection.config.vaultId) {
    const state = newLocalState(options.deviceId);
    state.vaultId = inspection.config.vaultId;
    options.store.reset(state);
    await options.store.persist();
  }
  return { keys, config: inspection.config };
}

export interface UploadSummary {
  readonly files: number;
  readonly bytes: number;
  readonly tooLarge: number;
}

/** What an initial upload will contain (shown to the user before anything is uploaded). */
export async function summarizeLocalFiles(fs: LocalFileSystem, filter: SyncFilter, maxFileSize: number): Promise<UploadSummary> {
  let files = 0;
  let bytes = 0;
  let tooLarge = 0;
  for (const info of await fs.list(filter)) {
    if (!filter.includes(info.path)) continue;
    if (info.size > maxFileSize) {
      tooLarge++;
      continue;
    }
    files++;
    bytes += info.size;
  }
  return { files, bytes, tooLarge };
}

/**
 * Replaces the public config with a transformed version (password change, recovery key) using the same
 * compare-and-swap discipline as data commits. Data objects and the manifest are untouched.
 */
async function updateRemoteConfig(
  crypto: CryptoProvider,
  remote: RemoteRepository,
  keys: VaultKeys,
  deviceId: string,
  transform: (config: PublicVaultConfig) => Promise<PublicVaultConfig>,
): Promise<PublicVaultConfig> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await remote.getHead();
    if (head.kind !== "ok") throw SyncError.blocked("BranchDeleted");
    const bytes = await remote.readConfig(head.commit);
    if (!bytes) throw SyncError.blocked("ConfigMissing");
    const config = parseVaultConfig(bytes);
    if (config.vaultId !== keys.vaultId) throw SyncError.blocked("ForeignVault");
    if (!(await keys.verifyConfigMac(crypto, config))) throw SyncError.blocked("ConfigCorrupted");
    const next = await transform(config);
    const changes: RemoteChange[] = [{ kind: "putConfig", config: next }];
    // Every commit that carries a manifest must carry one created on top of its parent (replay protection).
    const manifestBytes = await remote.readManifest(head.commit);
    if (manifestBytes) {
      const engine = new EncryptionEngine(crypto, keys);
      let current: Manifest;
      try {
        current = decodeManifest(await engine.decryptManifest(manifestBytes), keys.vaultId);
      } catch (error: unknown) {
        if (error instanceof SyncError) throw error;
        throw SyncError.blocked("ManifestCorrupted", { cause: error });
      }
      if (current.movedTo) throw SyncError.blocked("VaultMoved");
      const updated: Manifest = { ...current, formatVersion: formatVersionFor(current), version: current.version + 1, parentCommit: head.commit, device: deviceId, updatedAt: Date.now() };
      changes.push({ kind: "putManifest", blob: await engine.encryptManifest(encodeManifest(updated)) });
    }
    const commit = await remote.createCommit(head.commit, changes, {
      message: `Encrypted vault key update\n\nDevice: ${deviceId}\n`,
    });
    try {
      await remote.updateHead(head.commit, commit);
      return next;
    } catch (error: unknown) {
      if (error instanceof SyncError && error.code === "ConcurrentRemoteUpdate") continue;
      throw error;
    }
  }
  throw new SyncError("RetriesExhausted");
}

export async function changeVaultPassword(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  keys: VaultKeys;
  deviceId: string;
  newPassword: string;
}): Promise<PublicVaultConfig> {
  return updateRemoteConfig(options.crypto, options.remote, options.keys, options.deviceId, (config) =>
    changePassword(options.crypto, config, options.keys, options.newPassword),
  );
}

export async function rotateRecoveryKey(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  keys: VaultKeys;
  deviceId: string;
}): Promise<string> {
  let recoveryKey = "";
  await updateRemoteConfig(options.crypto, options.remote, options.keys, options.deviceId, async (config) => {
    const result = await regenerateRecoveryKey(options.crypto, config, options.keys);
    recoveryKey = result.recoveryKey;
    return result.config;
  });
  return recoveryKey;
}
