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
import { MANIFEST_FORMAT_VERSION, type Manifest } from "../manifest/Manifest";
import { checkConfigBinding, configHashOf, verifiedConfig } from "./HistoryReader";
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
 * Publishes a changed public config (password / recovery key). Must run under the SyncMutex right after a
 * successful sync: the remote head must be the last synchronised commit, and the new manifest is derived
 * from the LOCAL, fully verified state – never from whatever the remote currently serves (an attacker could
 * otherwise get an older manifest re-signed). Throws SyncError("ConcurrentRemoteUpdate") if the remote moved
 * on; the caller syncs and retries. Data objects are untouched.
 */
async function updateRemoteConfig(
  crypto: CryptoProvider,
  remote: RemoteRepository,
  store: SyncStateStore,
  keys: VaultKeys,
  deviceId: string,
  transform: (config: PublicVaultConfig) => Promise<PublicVaultConfig>,
): Promise<PublicVaultConfig> {
  const state = store.state;
  if (!state.vaultId || keys.vaultId !== state.vaultId) throw SyncError.blocked("ForeignVault");
  if (state.journal || state.pendingCommit) throw new SyncError("InvalidState", "an interrupted synchronisation must finish first");
  const head = await remote.getHead();
  if (head.kind !== "ok") throw SyncError.blocked("BranchDeleted");
  if (head.commit !== state.lastRemoteCommit) throw new SyncError("ConcurrentRemoteUpdate");
  const bytes = await remote.readConfig(head.commit);
  if (!bytes) throw SyncError.blocked("ConfigMissing");
  const current = state.remote;
  if (current?.movedTo) throw SyncError.blocked("VaultMoved");
  // The config at our verified head must be the one our manifest was written for.
  const config = await verifiedConfig(crypto, keys, bytes);
  if (current) await checkConfigBinding(crypto, current, bytes);
  const next = await transform(config);
  const changes: RemoteChange[] = [{ kind: "putConfig", config: next }];
  let updated: Manifest | null = null;
  // Always with a manifest bound to its parent – also on top of a bootstrap commit (version 0 → 1), so every
  // device can follow the authenticated chain across the key update.
  if (current) {
    updated = {
      ...current,
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: current.version + 1,
      parentCommit: head.commit,
      device: deviceId,
      updatedAt: Date.now(),
      configHash: await configHashOf(crypto, next),
    };
    const engine = new EncryptionEngine(crypto, keys);
    const encoded = encodeManifest(updated);
    decodeManifest(encoded, keys.vaultId);
    changes.push({ kind: "putManifest", blob: await engine.encryptManifest(encoded) });
  }
  const commit = await remote.createCommit(head.commit, changes, { message: `Encrypted vault key update\n\nDevice: ${deviceId}\n` });
  await remote.updateHead(head.commit, commit);
  // The key update is the new head: record it, so the next sync neither re-reads it nor mistakes it.
  state.lastRemoteCommit = commit;
  if (updated) {
    state.remote = updated;
    state.lastManifestVersion = updated.version;
  }
  await store.persist();
  return next;
}

export async function changeVaultPassword(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  store: SyncStateStore;
  keys: VaultKeys;
  deviceId: string;
  newPassword: string;
}): Promise<PublicVaultConfig> {
  return updateRemoteConfig(options.crypto, options.remote, options.store, options.keys, options.deviceId, (config) =>
    changePassword(options.crypto, config, options.keys, options.newPassword),
  );
}

export async function rotateRecoveryKey(options: {
  crypto: CryptoProvider;
  remote: RemoteRepository;
  store: SyncStateStore;
  keys: VaultKeys;
  deviceId: string;
}): Promise<{ recoveryKey: string; config: PublicVaultConfig }> {
  let recoveryKey = "";
  const config = await updateRemoteConfig(options.crypto, options.remote, options.store, options.keys, options.deviceId, async (config) => {
    const result = await regenerateRecoveryKey(options.crypto, config, options.keys);
    recoveryKey = result.recoveryKey;
    return result.config;
  });
  return { recoveryKey, config };
}
