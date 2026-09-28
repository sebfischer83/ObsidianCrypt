import { CryptoError } from "../errors/CryptoError";
import { isEnvelope } from "../crypto/EncryptionFormat";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "../util/bytes";

/**
 * Remote repository layout. The ONLY paths that ever appear remotely are the constants below and
 * `objects/<aa>/<objectId>` computed from a validated random object id.
 */

export const CONFIG_PATH = ".vaultsync/config";
export const MANIFEST_PATH = ".vaultsync/manifest.enc";
export const OBJECTS_DIR = "objects";

const OBJECT_ID = /^[0-9a-f]{32}$/;

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

export function objectPath(objectId: string): string {
  if (!OBJECT_ID.test(objectId)) throw new CryptoError("InvalidInput", "object id");
  return `${OBJECTS_DIR}/${objectId.slice(0, 2)}/${objectId}`;
}

/** Text armour used to batch small envelopes into GitHub tree requests. Transport encoding only. */
export const ARMOR_PREFIX = "OVSA1:";

export function armor(envelope: Uint8Array): string {
  assertEncrypted(envelope);
  return ARMOR_PREFIX + toBase64(envelope);
}

/** Accepts binary envelopes or armoured text and returns envelope bytes. */
export function unarmor(stored: Uint8Array): Uint8Array {
  if (isEnvelope(stored)) return stored;
  const prefix = utf8Encode(ARMOR_PREFIX);
  if (stored.length > prefix.length && prefix.every((b, i) => stored[i] === b)) {
    const decoded = fromBase64(utf8Decode(stored.subarray(prefix.length)));
    if (isEnvelope(decoded)) return decoded;
  }
  throw new CryptoError("UnsupportedFormat", "remote object is not an encrypted envelope");
}

/**
 * Defense in depth: every byte sequence handed to a remote write must look like an envelope. This
 * cannot prove encryption, but it catches any accidental plaintext path that bypassed the types.
 */
export function assertEncrypted(bytes: Uint8Array): void {
  if (!isEnvelope(bytes)) throw new CryptoError("InvalidInput", "refusing to upload data that is not an encrypted envelope");
}

export function buildCommitMessage(changeCount: number, deviceId: string): string {
  const noun = changeCount === 1 ? "change" : "changes";
  return `Encrypted vault sync: ${changeCount} ${noun}\n\nDevice: ${deviceId}\n`;
}

const DEVICE_TRAILER = /^Device: ([0-9a-f-]{36})$/m;

/** Device id from a commit message written by {@link buildCommitMessage}, or null. */
export function parseCommitDevice(message: string): string | null {
  return DEVICE_TRAILER.exec(message)?.[1] ?? null;
}

const OBJECT_PATH = /^objects\/([0-9a-f]{2})\/([0-9a-f]{32})$/;

/** Inverse of {@link objectPath}; null for any other path. */
export function objectIdFromPath(path: string): string | null {
  const m = OBJECT_PATH.exec(path);
  return m && m[2]!.startsWith(m[1]!) ? m[2]! : null;
}

const MIGRATION_PREFIX = "Encrypted vault migration: ";

/** Commits that copy the vault into a new repository (their versions duplicate the archive's). */
export function buildMigrationMessage(changeCount: number, deviceId: string): string {
  return `${MIGRATION_PREFIX}${changeCount} ${changeCount === 1 ? "change" : "changes"}\n\nDevice: ${deviceId}\n`;
}

export function isMigrationMessage(message: string): boolean {
  return message.startsWith(MIGRATION_PREFIX);
}

export function buildMovedMessage(deviceId: string): string {
  return `Encrypted vault moved\n\nDevice: ${deviceId}\n`;
}
