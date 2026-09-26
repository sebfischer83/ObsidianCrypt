import { argon2idAsync } from "@noble/hashes/argon2.js";
import { CryptoError } from "../errors/CryptoError";
import { fromBase64, toBase64, utf8Encode } from "../util/bytes";
import { canonicalJson } from "../util/canonicalJson";
import { BASE64, expectInteger, expectLiteral, expectOnlyKeys, expectRecord, expectString, ValidationError } from "../util/validate";
import type { CryptoProvider } from "./CryptoProvider";

/**
 * Password based key derivation (see docs/DESIGN.md §4 for the decision record).
 * Default: Argon2id (m = 64 MiB, t = 3, p = 1). Alternative: PBKDF2-SHA256 via WebCrypto.
 * Parameters are stored (non-secret) in the key slot and bound into the wrapping AAD.
 */

export interface Argon2idParams {
  readonly algorithm: "argon2id";
  /** Argon2 version 0x13. */
  readonly version: 19;
  readonly salt: string;
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export interface Pbkdf2Params {
  readonly algorithm: "pbkdf2-sha256";
  readonly salt: string;
  readonly iterations: number;
}

/** For high-entropy secrets (recovery key) a slow KDF is unnecessary. */
export interface HkdfSlotParams {
  readonly algorithm: "hkdf-sha256";
  readonly salt: string;
}

export type PasswordKdfParams = Argon2idParams | Pbkdf2Params;
export type KdfParams = PasswordKdfParams | HkdfSlotParams;
export type PasswordKdfAlgorithm = PasswordKdfParams["algorithm"];

export const KEK_LENGTH = 32;
export const SALT_LENGTH = 16;

/** Security floors (downgrade protection) and ceilings (DoS / mobile memory protection). */
export const KDF_LIMITS = {
  argon2id: { minMemoryKiB: 19456, maxMemoryKiB: 262144, minIterations: 2, maxIterations: 10, minParallelism: 1, maxParallelism: 4 },
  pbkdf2: { minIterations: 310000, maxIterations: 10_000_000 },
} as const;

export const DEFAULT_ARGON2ID = { memoryKiB: 65536, iterations: 3, parallelism: 1 } as const;
export const DEFAULT_PBKDF2_ITERATIONS = 600000;

export function newPasswordKdfParams(crypto: CryptoProvider, algorithm: PasswordKdfAlgorithm = "argon2id"): PasswordKdfParams {
  const salt = toBase64(crypto.randomBytes(SALT_LENGTH));
  if (algorithm === "argon2id") {
    return { algorithm: "argon2id", version: 19, salt, ...DEFAULT_ARGON2ID };
  }
  return { algorithm: "pbkdf2-sha256", salt, iterations: DEFAULT_PBKDF2_ITERATIONS };
}

export function newHkdfSlotParams(crypto: CryptoProvider): HkdfSlotParams {
  return { algorithm: "hkdf-sha256", salt: toBase64(crypto.randomBytes(SALT_LENGTH)) };
}

/** Passwords are NFC-normalised so the same password typed on different platforms derives the same key. */
export function normalizePassword(password: string): Uint8Array {
  return utf8Encode(password.normalize("NFC"));
}

export async function derivePasswordKek(crypto: CryptoProvider, password: string, params: PasswordKdfParams): Promise<Uint8Array> {
  validateKdfParams(params);
  const pw = normalizePassword(password);
  const salt = fromBase64(params.salt);
  try {
    if (params.algorithm === "argon2id") {
      return await argon2idAsync(pw, salt, {
        t: params.iterations,
        m: params.memoryKiB,
        p: params.parallelism,
        version: 0x13,
        dkLen: KEK_LENGTH,
        asyncTick: 20,
      });
    }
    return await crypto.pbkdf2Sha256(pw, salt, params.iterations, KEK_LENGTH);
  } finally {
    pw.fill(0);
  }
}

export async function deriveHkdfKek(crypto: CryptoProvider, secret: Uint8Array, params: HkdfSlotParams): Promise<Uint8Array> {
  validateKdfParams(params);
  return crypto.hkdfSha256(secret, fromBase64(params.salt), utf8Encode("ovs/v1/recovery-kek"), KEK_LENGTH);
}

export function canonicalKdf(params: KdfParams): string {
  return canonicalJson(params);
}

/** Validates untrusted KDF parameters (from the remote config). Throws CryptoError on weak/invalid values. */
export function parseKdfParams(value: unknown, field = "kdf"): KdfParams {
  try {
    const record = expectRecord(value, field);
    const algorithm = expectString(record.algorithm, `${field}.algorithm`);
    let params: KdfParams;
    if (algorithm === "argon2id") {
      expectOnlyKeys(record, ["algorithm", "version", "salt", "memoryKiB", "iterations", "parallelism"], field);
      params = {
        algorithm: "argon2id",
        version: expectLiteral(record.version, 19, `${field}.version`),
        salt: expectString(record.salt, `${field}.salt`, BASE64),
        memoryKiB: expectInteger(record.memoryKiB, `${field}.memoryKiB`),
        iterations: expectInteger(record.iterations, `${field}.iterations`),
        parallelism: expectInteger(record.parallelism, `${field}.parallelism`),
      };
    } else if (algorithm === "pbkdf2-sha256") {
      expectOnlyKeys(record, ["algorithm", "salt", "iterations"], field);
      params = {
        algorithm: "pbkdf2-sha256",
        salt: expectString(record.salt, `${field}.salt`, BASE64),
        iterations: expectInteger(record.iterations, `${field}.iterations`),
      };
    } else if (algorithm === "hkdf-sha256") {
      expectOnlyKeys(record, ["algorithm", "salt"], field);
      params = { algorithm: "hkdf-sha256", salt: expectString(record.salt, `${field}.salt`, BASE64) };
    } else {
      throw new CryptoError("UnsupportedFormat", "unknown KDF algorithm");
    }
    validateKdfParams(params);
    return params;
  } catch (error: unknown) {
    if (error instanceof ValidationError) throw new CryptoError("InvalidInput", error.message);
    throw error;
  }
}

export function validateKdfParams(params: KdfParams): void {
  let saltLength: number;
  try {
    saltLength = fromBase64(params.salt).length;
  } catch (error: unknown) {
    throw new CryptoError("InvalidInput", "salt encoding", { cause: error });
  }
  if (saltLength < SALT_LENGTH) throw new CryptoError("WeakParameters", "salt too short");
  if (params.algorithm === "argon2id") {
    const l = KDF_LIMITS.argon2id;
    if (params.version !== 19) throw new CryptoError("UnsupportedFormat", "argon2 version");
    if (params.memoryKiB < l.minMemoryKiB || params.iterations < l.minIterations || params.parallelism < l.minParallelism) {
      throw new CryptoError("WeakParameters", "argon2id");
    }
    if (params.memoryKiB > l.maxMemoryKiB || params.iterations > l.maxIterations || params.parallelism > l.maxParallelism) {
      throw new CryptoError("InvalidInput", "argon2id parameters exceed supported maximum");
    }
  } else if (params.algorithm === "pbkdf2-sha256") {
    const l = KDF_LIMITS.pbkdf2;
    if (params.iterations < l.minIterations) throw new CryptoError("WeakParameters", "pbkdf2");
    if (params.iterations > l.maxIterations) throw new CryptoError("InvalidInput", "pbkdf2 iterations exceed supported maximum");
  }
}
