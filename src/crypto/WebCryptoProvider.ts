import { CryptoError } from "../errors/CryptoError";
import { asBufferSource, toHex } from "../util/bytes";
import type { CryptoProvider, EncryptedData } from "./CryptoProvider";

const NONCE_LENGTH = 12;
const TAG_LENGTH_BITS = 128;
const KEY_LENGTH = 32;
/** WebCrypto getRandomValues is limited to 65536 bytes per call. */
const RANDOM_CHUNK = 65536;

export class WebCryptoProvider implements CryptoProvider {
  private readonly subtle: SubtleCrypto;

  constructor(private readonly cryptoImpl: Crypto = globalThis.crypto) {
    if (!cryptoImpl || !cryptoImpl.subtle) {
      throw new CryptoError("InvalidInput", "WebCrypto is not available on this platform");
    }
    this.subtle = cryptoImpl.subtle;
  }

  randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += RANDOM_CHUNK) {
      this.cryptoImpl.getRandomValues(out.subarray(offset, Math.min(length, offset + RANDOM_CHUNK)));
    }
    return out;
  }

  async importAeadKey(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== KEY_LENGTH) throw new CryptoError("InvalidInput", "AES-256 key must be 32 bytes");
    return this.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async encrypt(plaintext: Uint8Array, key: CryptoKey, associatedData: Uint8Array): Promise<EncryptedData> {
    assertAesGcmKey(key);
    const nonce = this.randomBytes(NONCE_LENGTH);
    const ciphertext = await this.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce), additionalData: asBufferSource(associatedData), tagLength: TAG_LENGTH_BITS },
      key,
      asBufferSource(plaintext),
    );
    return { algorithm: "AES-256-GCM", nonce, ciphertext: new Uint8Array(ciphertext) };
  }

  async decrypt(data: EncryptedData, key: CryptoKey, associatedData: Uint8Array): Promise<Uint8Array> {
    assertAesGcmKey(key);
    if (data.algorithm !== "AES-256-GCM") throw new CryptoError("UnsupportedFormat", "algorithm");
    if (data.nonce.length !== NONCE_LENGTH) throw new CryptoError("DecryptionFailed", "nonce length");
    if (data.ciphertext.length < TAG_LENGTH_BITS / 8) throw new CryptoError("DecryptionFailed", "truncated");
    try {
      const plaintext = await this.subtle.decrypt(
        { name: "AES-GCM", iv: asBufferSource(data.nonce), additionalData: asBufferSource(associatedData), tagLength: TAG_LENGTH_BITS },
        key,
        asBufferSource(data.ciphertext),
      );
      return new Uint8Array(plaintext);
    } catch (error: unknown) {
      // WebCrypto throws OperationError on tag mismatch. Never return partial plaintext.
      throw new CryptoError("DecryptionFailed", undefined, { cause: error });
    }
  }

  async hash(data: Uint8Array): Promise<string> {
    return toHex(await this.sha256(data));
  }

  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.subtle.digest("SHA-256", asBufferSource(data)));
  }

  async hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    const base = await this.subtle.importKey("raw", asBufferSource(ikm), "HKDF", false, ["deriveBits"]);
    const bits = await this.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: asBufferSource(salt), info: asBufferSource(info) },
      base,
      length * 8,
    );
    return new Uint8Array(bits);
  }

  async hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const hmacKey = await this.subtle.importKey("raw", asBufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await this.subtle.sign("HMAC", hmacKey, asBufferSource(data)));
  }

  async pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
    const base = await this.subtle.importKey("raw", asBufferSource(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await this.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: asBufferSource(salt), iterations },
      base,
      length * 8,
    );
    return new Uint8Array(bits);
  }
}

function assertAesGcmKey(key: CryptoKey): void {
  if (key.algorithm.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new CryptoError("InvalidInput", "expected AES-256-GCM key");
  }
}
