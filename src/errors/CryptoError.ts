import { VaultSyncError } from "./VaultSyncError";

export type CryptoErrorCode =
  | "DecryptionFailed"
  | "WrongPassword"
  | "WrongRecoveryKey"
  | "UnsupportedFormat"
  | "InvalidInput"
  | "IntegrityMismatch"
  | "ConfigIntegrity"
  | "WeakParameters"
  | "Locked";

const MESSAGES: Record<CryptoErrorCode, string> = {
  DecryptionFailed: "Decryption failed: data is corrupted, manipulated or encrypted with a different key.",
  WrongPassword: "The vault password is incorrect.",
  WrongRecoveryKey: "The recovery key is incorrect.",
  UnsupportedFormat: "The encrypted data uses an unknown or unsupported format version.",
  InvalidInput: "Invalid cryptographic input.",
  IntegrityMismatch: "Integrity check failed: decrypted content does not match the manifest.",
  ConfigIntegrity: "The repository configuration failed its integrity check (manipulated or belongs to a different vault).",
  WeakParameters: "The key derivation parameters are outside the accepted security range.",
  Locked: "The vault is locked. Enter the vault password to continue.",
};

export class CryptoError extends VaultSyncError {
  readonly domain = "crypto" as const;

  constructor(readonly code: CryptoErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code], options);
  }
}
