import { CryptoError } from "../errors/CryptoError";
import {
  configMacInput,
  CONFIG_TYPE,
  SUPPORTED_FORMAT_VERSION,
  type KeySlot,
  type PublicVaultConfig,
  type UnsignedVaultConfig,
} from "../manifest/VaultConfig";
import { constantTimeEqual, fromBase64, toBase64, toHex, utf8Encode, wipe } from "../util/bytes";
import type { CryptoProvider } from "./CryptoProvider";
import { Contexts, EnvelopeKind, openEnvelope, sealEnvelope } from "./EncryptionFormat";
import {
  canonicalKdf,
  deriveHkdfKek,
  derivePasswordKek,
  newHkdfSlotParams,
  newPasswordKdfParams,
  type PasswordKdfAlgorithm,
  type PasswordKdfParams,
} from "./KeyDerivation";
import { formatRecoveryKey, generateRecoverySecret, parseRecoveryKey } from "./RecoveryKey";

export const MASTER_KEY_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 12;

const INFO_OBJECT_KEY = "ovs/v1/object-key";
const INFO_MANIFEST_KEY = "ovs/v1/manifest-key";
const INFO_CONFIG_MAC = "ovs/v1/config-mac";

/**
 * Unlocked key material of one vault. Data keys are non-extractable WebCrypto keys; the raw master key
 * is kept only so it can optionally be stored in the OS keychain ("remember on this device").
 */
export class VaultKeys {
  #masterKey: Uint8Array | null;
  #macKey: Uint8Array | null;
  #objectKey: CryptoKey | null;
  #manifestKey: CryptoKey | null;

  private constructor(
    readonly vaultId: string,
    masterKey: Uint8Array,
    macKey: Uint8Array,
    objectKey: CryptoKey,
    manifestKey: CryptoKey,
  ) {
    this.#masterKey = masterKey;
    this.#macKey = macKey;
    this.#objectKey = objectKey;
    this.#manifestKey = manifestKey;
  }

  static async fromMasterKey(crypto: CryptoProvider, vaultId: string, masterKey: Uint8Array): Promise<VaultKeys> {
    if (masterKey.length !== MASTER_KEY_LENGTH) throw new CryptoError("InvalidInput", "master key length");
    const mk = masterKey.slice();
    const salt = utf8Encode(`ovs/v1/${vaultId}`);
    const objectRaw = await crypto.hkdfSha256(mk, salt, utf8Encode(INFO_OBJECT_KEY), 32);
    const manifestRaw = await crypto.hkdfSha256(mk, salt, utf8Encode(INFO_MANIFEST_KEY), 32);
    const macKey = await crypto.hkdfSha256(mk, salt, utf8Encode(INFO_CONFIG_MAC), 32);
    try {
      const objectKey = await crypto.importAeadKey(objectRaw);
      const manifestKey = await crypto.importAeadKey(manifestRaw);
      return new VaultKeys(vaultId, mk, macKey, objectKey, manifestKey);
    } finally {
      wipe(objectRaw);
      wipe(manifestRaw);
    }
  }

  get destroyed(): boolean {
    return this.#masterKey === null;
  }

  get objectKey(): CryptoKey {
    if (!this.#objectKey) throw new CryptoError("Locked");
    return this.#objectKey;
  }

  get manifestKey(): CryptoKey {
    if (!this.#manifestKey) throw new CryptoError("Locked");
    return this.#manifestKey;
  }

  /** Copy of the raw master key (for the OS keychain only). Caller must wipe it after use. */
  exportMasterKey(): Uint8Array {
    if (!this.#masterKey) throw new CryptoError("Locked");
    return this.#masterKey.slice();
  }

  async computeConfigMac(crypto: CryptoProvider, config: UnsignedVaultConfig | PublicVaultConfig): Promise<string> {
    if (!this.#macKey) throw new CryptoError("Locked");
    return toBase64(await crypto.hmacSha256(this.#macKey, configMacInput(config)));
  }

  async verifyConfigMac(crypto: CryptoProvider, config: PublicVaultConfig): Promise<boolean> {
    if (config.vaultId !== this.vaultId) return false;
    const expected = fromBase64(await this.computeConfigMac(crypto, config));
    let actual: Uint8Array;
    try {
      actual = fromBase64(config.mac);
    } catch (error: unknown) {
      if (error instanceof Error) return false;
      throw error;
    }
    return constantTimeEqual(expected, actual);
  }

  /** Short non-secret fingerprint for diagnostics (derived from the MAC key, not the master key). */
  async fingerprint(crypto: CryptoProvider): Promise<string> {
    if (!this.#macKey) throw new CryptoError("Locked");
    return toHex(await crypto.hmacSha256(this.#macKey, utf8Encode("fingerprint"))).slice(0, 16);
  }

  /** Removes key material from memory (best effort; JS cannot guarantee erasure). */
  destroy(): void {
    wipe(this.#masterKey);
    wipe(this.#macKey);
    this.#masterKey = null;
    this.#macKey = null;
    this.#objectKey = null;
    this.#manifestKey = null;
  }
}

export interface CreatedVault {
  readonly config: PublicVaultConfig;
  readonly keys: VaultKeys;
  /** Displayed once to the user; never stored. */
  readonly recoveryKey: string | null;
}

export function assertPasswordAcceptable(password: string): void {
  if ([...password.normalize("NFC")].length < MIN_PASSWORD_LENGTH) {
    throw new CryptoError("InvalidInput", `password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

async function wrapMasterKey(
  crypto: CryptoProvider,
  vaultId: string,
  slotId: string,
  type: KeySlot["type"],
  kdf: KeySlot["kdf"],
  kek: Uint8Array,
  masterKey: Uint8Array,
): Promise<KeySlot> {
  try {
    const key = await crypto.importAeadKey(kek);
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.KeySlot, masterKey, Contexts.keySlot(vaultId, slotId, canonicalKdf(kdf)));
    return { id: slotId, type, kdf, wrappedKey: toBase64(blob.bytes) };
  } finally {
    wipe(kek);
  }
}

async function unwrapMasterKey(crypto: CryptoProvider, vaultId: string, slot: KeySlot, kek: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await crypto.importAeadKey(kek);
    const mk = await openEnvelope(
      crypto,
      key,
      EnvelopeKind.KeySlot,
      fromBase64(slot.wrappedKey),
      Contexts.keySlot(vaultId, slot.id, canonicalKdf(slot.kdf)),
    );
    if (mk.length !== MASTER_KEY_LENGTH) throw new CryptoError("DecryptionFailed", "master key length");
    return mk;
  } finally {
    wipe(kek);
  }
}

async function sign(crypto: CryptoProvider, keys: VaultKeys, unsigned: UnsignedVaultConfig): Promise<PublicVaultConfig> {
  return { ...unsigned, mac: await keys.computeConfigMac(crypto, unsigned) };
}

/** Creates a brand-new vault: random master key, password slot and (optionally) recovery slot. */
export async function createVault(
  crypto: CryptoProvider,
  password: string,
  options: { withRecoveryKey?: boolean; kdf?: PasswordKdfAlgorithm } = {},
): Promise<CreatedVault> {
  assertPasswordAcceptable(password);
  const vaultId = toHex(crypto.randomBytes(16));
  const masterKey = crypto.randomBytes(MASTER_KEY_LENGTH);
  try {
    const kdf = newPasswordKdfParams(crypto, options.kdf ?? "argon2id");
    const slots: KeySlot[] = [
      await wrapMasterKey(crypto, vaultId, "password", "password", kdf, await derivePasswordKek(crypto, password, kdf), masterKey),
    ];
    let recoveryKey: string | null = null;
    if (options.withRecoveryKey !== false) {
      const secret = generateRecoverySecret(crypto);
      try {
        const params = newHkdfSlotParams(crypto);
        slots.push(await wrapMasterKey(crypto, vaultId, "recovery", "recovery", params, await deriveHkdfKek(crypto, secret, params), masterKey));
        recoveryKey = formatRecoveryKey(secret);
      } finally {
        wipe(secret);
      }
    }
    const keys = await VaultKeys.fromMasterKey(crypto, vaultId, masterKey);
    const config = await sign(crypto, keys, {
      type: CONFIG_TYPE,
      formatVersion: SUPPORTED_FORMAT_VERSION,
      vaultId,
      encryption: { algorithm: "AES-256-GCM", version: 1 },
      keyDerivation: { algorithm: "HKDF-SHA256", version: 1 },
      keySlots: slots,
    });
    return { config, keys, recoveryKey };
  } finally {
    wipe(masterKey);
  }
}

async function keysFromMasterKeyVerified(crypto: CryptoProvider, config: PublicVaultConfig, mk: Uint8Array): Promise<VaultKeys> {
  try {
    const keys = await VaultKeys.fromMasterKey(crypto, config.vaultId, mk);
    if (!(await keys.verifyConfigMac(crypto, config))) {
      keys.destroy();
      throw new CryptoError("ConfigIntegrity");
    }
    return keys;
  } finally {
    wipe(mk);
  }
}

export async function unlockWithPassword(crypto: CryptoProvider, config: PublicVaultConfig, password: string): Promise<VaultKeys> {
  const slot = config.keySlots.find((s) => s.type === "password");
  if (!slot || slot.kdf.algorithm === "hkdf-sha256") throw new CryptoError("InvalidInput", "no password slot");
  let mk: Uint8Array;
  try {
    mk = await unwrapMasterKey(crypto, config.vaultId, slot, await derivePasswordKek(crypto, password, slot.kdf));
  } catch (error: unknown) {
    if (error instanceof CryptoError && error.code === "DecryptionFailed") throw new CryptoError("WrongPassword", undefined, { cause: error });
    throw error;
  }
  return keysFromMasterKeyVerified(crypto, config, mk);
}

export async function unlockWithRecoveryKey(crypto: CryptoProvider, config: PublicVaultConfig, recoveryKey: string): Promise<VaultKeys> {
  const slot = config.keySlots.find((s) => s.type === "recovery");
  if (!slot || slot.kdf.algorithm !== "hkdf-sha256") throw new CryptoError("InvalidInput", "vault has no recovery key");
  const secret = parseRecoveryKey(recoveryKey);
  let mk: Uint8Array;
  try {
    mk = await unwrapMasterKey(crypto, config.vaultId, slot, await deriveHkdfKek(crypto, secret, slot.kdf));
  } catch (error: unknown) {
    if (error instanceof CryptoError && error.code === "DecryptionFailed") throw new CryptoError("WrongRecoveryKey", undefined, { cause: error });
    throw error;
  } finally {
    wipe(secret);
  }
  return keysFromMasterKeyVerified(crypto, config, mk);
}

/** Unlocks with a master key remembered in the OS keychain. Fails if the config does not belong to it. */
export async function unlockWithMasterKey(crypto: CryptoProvider, config: PublicVaultConfig, masterKey: Uint8Array): Promise<VaultKeys> {
  return keysFromMasterKeyVerified(crypto, config, masterKey.slice());
}

/**
 * Re-wraps the SAME master key with a new password (new salt, new KEK). Data objects stay untouched.
 */
export async function changePassword(
  crypto: CryptoProvider,
  config: PublicVaultConfig,
  keys: VaultKeys,
  newPassword: string,
  kdfAlgorithm?: PasswordKdfAlgorithm,
): Promise<PublicVaultConfig> {
  assertPasswordAcceptable(newPassword);
  if (!(await keys.verifyConfigMac(crypto, config))) throw new CryptoError("ConfigIntegrity");
  const current = config.keySlots.find((s) => s.type === "password");
  const algorithm = kdfAlgorithm ?? (current?.kdf.algorithm === "pbkdf2-sha256" ? "pbkdf2-sha256" : "argon2id");
  const kdf: PasswordKdfParams = newPasswordKdfParams(crypto, algorithm);
  const mk = keys.exportMasterKey();
  try {
    const slot = await wrapMasterKey(crypto, config.vaultId, "password", "password", kdf, await derivePasswordKek(crypto, newPassword, kdf), mk);
    const { mac: _mac, ...unsigned } = config;
    return sign(crypto, keys, { ...unsigned, keySlots: [slot, ...config.keySlots.filter((s) => s.type !== "password")] });
  } finally {
    wipe(mk);
  }
}

/** Replaces the recovery slot with a new random recovery key. */
export async function regenerateRecoveryKey(
  crypto: CryptoProvider,
  config: PublicVaultConfig,
  keys: VaultKeys,
): Promise<{ config: PublicVaultConfig; recoveryKey: string }> {
  if (!(await keys.verifyConfigMac(crypto, config))) throw new CryptoError("ConfigIntegrity");
  const mk = keys.exportMasterKey();
  const secret = generateRecoverySecret(crypto);
  try {
    const params = newHkdfSlotParams(crypto);
    const slot = await wrapMasterKey(crypto, config.vaultId, "recovery", "recovery", params, await deriveHkdfKek(crypto, secret, params), mk);
    const { mac: _mac, ...unsigned } = config;
    const next = await sign(crypto, keys, { ...unsigned, keySlots: [...config.keySlots.filter((s) => s.type !== "recovery"), slot] });
    return { config: next, recoveryKey: formatRecoveryKey(secret) };
  } finally {
    wipe(mk);
    wipe(secret);
  }
}

/**
 * Holds the unlocked keys of the current session. Lock removes them from memory.
 */
export class KeyManager {
  #keys: VaultKeys | null = null;

  get isUnlocked(): boolean {
    return this.#keys !== null && !this.#keys.destroyed;
  }

  get keys(): VaultKeys {
    if (!this.#keys || this.#keys.destroyed) throw new CryptoError("Locked");
    return this.#keys;
  }

  get vaultId(): string | null {
    return this.#keys?.vaultId ?? null;
  }

  setKeys(keys: VaultKeys): void {
    if (this.#keys && this.#keys !== keys) this.#keys.destroy();
    this.#keys = keys;
  }

  lock(): void {
    this.#keys?.destroy();
    this.#keys = null;
  }
}
