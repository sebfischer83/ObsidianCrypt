import { CryptoError } from "../errors/CryptoError";
import { SyncError } from "../errors/SyncError";
import { parseKdfParams, type KdfParams } from "../crypto/KeyDerivation";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { canonicalJson } from "../util/canonicalJson";
import {
  BASE64,
  expectArray,
  expectInteger,
  expectLiteral,
  expectOnlyKeys,
  expectRecord,
  expectString,
  HEX_32,
  ValidationError,
} from "../util/validate";

/** Newest repository format this plugin version understands. Newer repositories are never modified. */
export const SUPPORTED_FORMAT_VERSION = 1;
export const CONFIG_TYPE = "obsidian-encrypted-sync";

export type KeySlotType = "password" | "recovery";

export interface KeySlot {
  readonly id: string;
  readonly type: KeySlotType;
  readonly kdf: KdfParams;
  /** Base64 of a key-slot envelope containing the wrapped vault master key. */
  readonly wrappedKey: string;
}

/**
 * The public, non-secret repository configuration (`.vaultsync/config`). Contains only random ids,
 * algorithm identifiers, KDF parameters and wrapped (encrypted) keys.
 */
export interface PublicVaultConfig {
  readonly type: typeof CONFIG_TYPE;
  readonly formatVersion: number;
  readonly vaultId: string;
  readonly encryption: { readonly algorithm: "AES-256-GCM"; readonly version: 1 };
  readonly keyDerivation: { readonly algorithm: "HKDF-SHA256"; readonly version: 1 };
  readonly keySlots: readonly KeySlot[];
  /** Base64 HMAC-SHA256 over the canonical JSON of all other fields. */
  readonly mac: string;
}

export type UnsignedVaultConfig = Omit<PublicVaultConfig, "mac">;

export function configMacInput(config: UnsignedVaultConfig | PublicVaultConfig): Uint8Array {
  const { mac: _mac, ...rest } = config as PublicVaultConfig;
  return utf8Encode(canonicalJson(rest));
}

export function serializeVaultConfig(config: PublicVaultConfig): Uint8Array {
  return utf8Encode(`${JSON.stringify(config, null, 2)}\n`);
}

const SLOT_ID = /^[a-z0-9-]{1,32}$/;

/**
 * Parses and validates the remote configuration. Throws SyncError(Blocked) for anything that is not a
 * well-formed configuration of a supported format version.
 */
/** Largest `.vaultsync/config` accepted (a few key slots are a few KiB); checked before parsing. */
export const MAX_CONFIG_BYTES = 256 * 1024;

export function parseVaultConfig(bytes: Uint8Array): PublicVaultConfig {
  if (bytes.length > MAX_CONFIG_BYTES) throw SyncError.blocked("ConfigCorrupted");
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes));
  } catch (error: unknown) {
    throw SyncError.blocked("ConfigCorrupted", { cause: error });
  }
  try {
    const record = expectRecord(raw, "config");
    expectLiteral(record.type, CONFIG_TYPE, "config.type");
    const formatVersion = expectInteger(record.formatVersion, "config.formatVersion", 1);
    if (formatVersion > SUPPORTED_FORMAT_VERSION) throw SyncError.blocked("UnknownFormatVersion");
    expectOnlyKeys(record, ["type", "formatVersion", "vaultId", "encryption", "keyDerivation", "keySlots", "mac"], "config");
    const encryption = expectRecord(record.encryption, "config.encryption");
    expectOnlyKeys(encryption, ["algorithm", "version"], "config.encryption");
    const keyDerivation = expectRecord(record.keyDerivation, "config.keyDerivation");
    expectOnlyKeys(keyDerivation, ["algorithm", "version"], "config.keyDerivation");
    if (encryption.algorithm !== "AES-256-GCM" || encryption.version !== 1) throw SyncError.blocked("UnknownFormatVersion");
    if (keyDerivation.algorithm !== "HKDF-SHA256" || keyDerivation.version !== 1) throw SyncError.blocked("UnknownFormatVersion");

    const slots = expectArray(record.keySlots, "config.keySlots").map((slot, i) => parseSlot(slot, `config.keySlots[${i}]`));
    if (slots.length === 0 || slots.length > 16) throw new ValidationError("config.keySlots", "invalid count");
    const ids = new Set(slots.map((s) => s.id));
    if (ids.size !== slots.length) throw new ValidationError("config.keySlots", "duplicate slot id");
    if (!slots.some((s) => s.type === "password")) throw new ValidationError("config.keySlots", "no password slot");

    return {
      type: CONFIG_TYPE,
      formatVersion,
      vaultId: expectString(record.vaultId, "config.vaultId", HEX_32),
      encryption: { algorithm: "AES-256-GCM", version: 1 },
      keyDerivation: { algorithm: "HKDF-SHA256", version: 1 },
      keySlots: slots,
      mac: expectString(record.mac, "config.mac", BASE64),
    };
  } catch (error: unknown) {
    if (error instanceof SyncError) throw error;
    if (error instanceof CryptoError && error.code === "UnsupportedFormat") throw SyncError.blocked("UnknownFormatVersion", { cause: error });
    throw SyncError.blocked("ConfigCorrupted", { cause: error });
  }
}

function parseSlot(value: unknown, field: string): KeySlot {
  const record = expectRecord(value, field);
  expectOnlyKeys(record, ["id", "type", "kdf", "wrappedKey"], field);
  const type = expectString(record.type, `${field}.type`);
  if (type !== "password" && type !== "recovery") throw new ValidationError(`${field}.type`, "unknown slot type");
  const kdf = parseKdfParams(record.kdf, `${field}.kdf`);
  if (type === "password" && kdf.algorithm === "hkdf-sha256") throw new ValidationError(`${field}.kdf`, "password slot requires slow KDF");
  if (type === "recovery" && kdf.algorithm !== "hkdf-sha256") throw new ValidationError(`${field}.kdf`, "recovery slot requires hkdf");
  return {
    id: expectString(record.id, `${field}.id`, SLOT_ID),
    type,
    kdf,
    wrappedKey: expectString(record.wrappedKey, `${field}.wrappedKey`, BASE64),
  };
}
