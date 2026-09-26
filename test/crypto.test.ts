import { describe, expect, it } from "vitest";
import { argon2id } from "@noble/hashes/argon2.js";
import { WebCryptoProvider } from "../src/crypto/WebCryptoProvider";
import {
  EncryptedBlob,
  EnvelopeKind,
  HEADER_LENGTH,
  isEnvelope,
  openEnvelope,
  parseEnvelope,
  sealEnvelope,
} from "../src/crypto/EncryptionFormat";
import { EncryptionEngine } from "../src/crypto/EncryptionEngine";
import {
  changePassword,
  createVault,
  KeyManager,
  regenerateRecoveryKey,
  unlockWithMasterKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  VaultKeys,
} from "../src/crypto/KeyManager";
import { parseKdfParams, validateKdfParams } from "../src/crypto/KeyDerivation";
import { formatRecoveryKey, parseRecoveryKey } from "../src/crypto/RecoveryKey";
import { CryptoError } from "../src/errors/CryptoError";
import { fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from "../src/util/bytes";
import { parseVaultConfig, serializeVaultConfig } from "../src/manifest/VaultConfig";

const crypto = new WebCryptoProvider();
const PASSWORD = "correct horse battery staple";

async function randomKey(): Promise<CryptoKey> {
  return crypto.importAeadKey(crypto.randomBytes(32));
}

async function expectCryptoError(promise: Promise<unknown>, code: CryptoError["code"]): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CryptoError);
  await promise.catch((e: unknown) => expect((e as CryptoError).code).toBe(code));
}

describe("bytes helpers", () => {
  it("base64 round-trips all lengths and matches btoa", () => {
    for (let len = 0; len < 70; len++) {
      const data = crypto.randomBytes(len);
      const b64 = toBase64(data);
      expect(b64).toBe(btoa(String.fromCharCode(...data)));
      expect(fromBase64(b64)).toEqual(data);
    }
  });

  it("hex round-trips", () => {
    const data = crypto.randomBytes(33);
    expect(fromHex(toHex(data))).toEqual(data);
  });

  it("rejects invalid base64", () => {
    expect(() => fromBase64("abc")).toThrow();
    expect(() => fromBase64("ab$=")).toThrow();
  });
});

describe("AES-256-GCM provider", () => {
  it("encrypt → decrypt == original", async () => {
    const key = await randomKey();
    const plaintext = utf8Encode("SuperSecretNote – Customer Müller");
    const aad = utf8Encode("ctx");
    const enc = await crypto.encrypt(plaintext, key, aad);
    expect(await crypto.decrypt(enc, key, aad)).toEqual(plaintext);
  });

  it("wrong key → error", async () => {
    const enc = await crypto.encrypt(utf8Encode("x"), await randomKey(), new Uint8Array());
    await expectCryptoError(crypto.decrypt(enc, await randomKey(), new Uint8Array()), "DecryptionFailed");
  });

  it("wrong associated data → error", async () => {
    const key = await randomKey();
    const enc = await crypto.encrypt(utf8Encode("x"), key, utf8Encode("a"));
    await expectCryptoError(crypto.decrypt(enc, key, utf8Encode("b")), "DecryptionFailed");
  });

  it("nonces are unique", async () => {
    const key = await randomKey();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const enc = await crypto.encrypt(new Uint8Array([1]), key, new Uint8Array());
      expect(enc.nonce.length).toBe(12);
      seen.add(toHex(enc.nonce));
    }
    expect(seen.size).toBe(2000);
  });

  it("same plaintext encrypts to different ciphertexts", async () => {
    const key = await randomKey();
    const a = await crypto.encrypt(utf8Encode("same"), key, new Uint8Array());
    const b = await crypto.encrypt(utf8Encode("same"), key, new Uint8Array());
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
  });
});

describe("envelope format", () => {
  it("contains magic, version, algorithm, kind, nonce, ciphertext and tag", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello"), "ctx");
    const bytes = blob.bytes;
    expect(utf8Decode(bytes.subarray(0, 4))).toBe("OVSE");
    expect(bytes[4]).toBe(1);
    expect(bytes[5]).toBe(1);
    expect(bytes[6]).toBe(EnvelopeKind.Object);
    expect(bytes.length).toBe(HEADER_LENGTH + 5 + 16);
    const parsed = parseEnvelope(bytes);
    expect(parsed.nonce.length).toBe(12);
    expect(isEnvelope(bytes)).toBe(true);
  });

  it("modified ciphertext → error", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello world"), "ctx");
    const tampered = blob.bytes.slice();
    tampered[HEADER_LENGTH + 2] = (tampered[HEADER_LENGTH + 2] as number) ^ 0x01;
    await expectCryptoError(openEnvelope(crypto, key, EnvelopeKind.Object, tampered, "ctx"), "DecryptionFailed");
  });

  it("modified authentication tag → error", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello world"), "ctx");
    const tampered = blob.bytes.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x80;
    await expectCryptoError(openEnvelope(crypto, key, EnvelopeKind.Object, tampered, "ctx"), "DecryptionFailed");
  });

  it("modified nonce → error", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello"), "ctx");
    const tampered = blob.bytes.slice();
    tampered[9] = (tampered[9] as number) ^ 0x01;
    await expectCryptoError(openEnvelope(crypto, key, EnvelopeKind.Object, tampered, "ctx"), "DecryptionFailed");
  });

  it("modified header kind → rejected", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello"), "ctx");
    const tampered = blob.bytes.slice();
    tampered[6] = EnvelopeKind.Manifest;
    await expect(openEnvelope(crypto, key, EnvelopeKind.Manifest, tampered, "ctx")).rejects.toBeInstanceOf(CryptoError);
    await expect(openEnvelope(crypto, key, EnvelopeKind.Object, tampered, "ctx")).rejects.toBeInstanceOf(CryptoError);
  });

  it("truncated envelope → error", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello"), "ctx");
    await expect(openEnvelope(crypto, key, EnvelopeKind.Object, blob.bytes.subarray(0, 30), "ctx")).rejects.toBeInstanceOf(CryptoError);
  });

  it("unknown version/algorithm → UnsupportedFormat", async () => {
    const key = await randomKey();
    const blob = await sealEnvelope(crypto, key, EnvelopeKind.Object, utf8Encode("hello"), "ctx");
    const v2 = blob.bytes.slice();
    v2[4] = 2;
    await expectCryptoError(openEnvelope(crypto, key, EnvelopeKind.Object, v2, "ctx"), "UnsupportedFormat");
    const alg = blob.bytes.slice();
    alg[5] = 9;
    await expectCryptoError(openEnvelope(crypto, key, EnvelopeKind.Object, alg, "ctx"), "UnsupportedFormat");
  });

  it("plaintext can not be turned into an EncryptedBlob", () => {
    expect(() => EncryptedBlob.fromSealed(Symbol("fake"), utf8Encode("plaintext"), EnvelopeKind.Object)).toThrow(CryptoError);
  });
});

describe("KDF", () => {
  it("argon2id implementation matches RFC 9106 test vector", () => {
    const password = new Uint8Array(32).fill(0x01);
    const salt = new Uint8Array(16).fill(0x02);
    const key = new Uint8Array(8).fill(0x03);
    const ad = new Uint8Array(12).fill(0x04);
    const tag = argon2id(password, salt, { t: 3, m: 32, p: 4, key, personalization: ad, dkLen: 32 });
    expect(toHex(tag)).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("rejects weak parameters (downgrade protection)", () => {
    const salt = toBase64(new Uint8Array(16));
    expect(() => validateKdfParams({ algorithm: "argon2id", version: 19, salt, memoryKiB: 1024, iterations: 3, parallelism: 1 })).toThrow(CryptoError);
    expect(() => validateKdfParams({ algorithm: "pbkdf2-sha256", salt, iterations: 1000 })).toThrow(CryptoError);
    expect(() => validateKdfParams({ algorithm: "pbkdf2-sha256", salt: toBase64(new Uint8Array(4)), iterations: 600000 })).toThrow(CryptoError);
  });

  it("rejects unknown KDF algorithms and extra fields", () => {
    expect(() => parseKdfParams({ algorithm: "md5", salt: "" })).toThrow(CryptoError);
    expect(() => parseKdfParams({ algorithm: "hkdf-sha256", salt: toBase64(new Uint8Array(16)), extra: 1 })).toThrow(CryptoError);
  });
});

describe("recovery key", () => {
  it("round-trips and tolerates formatting", () => {
    const secret = crypto.randomBytes(32);
    const formatted = formatRecoveryKey(secret);
    expect(formatted).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    expect(parseRecoveryKey(formatted)).toEqual(secret);
    expect(parseRecoveryKey(formatted.toLowerCase().replace(/-/g, " "))).toEqual(secret);
  });

  it("detects typos via checksum", () => {
    const formatted = formatRecoveryKey(crypto.randomBytes(32));
    const typo = (formatted[0] === "A" ? "B" : "A") + formatted.slice(1);
    expect(() => parseRecoveryKey(typo)).toThrow(CryptoError);
  });
});

describe("key management", () => {
  it("creates a vault and unlocks with password (argon2id)", async () => {
    const created = await createVault(crypto, PASSWORD);
    const slot = created.config.keySlots.find((s) => s.type === "password");
    expect(slot?.kdf.algorithm).toBe("argon2id");
    const keys = await unlockWithPassword(crypto, created.config, PASSWORD);
    expect(toHex(keys.exportMasterKey())).toBe(toHex(created.keys.exportMasterKey()));
  });

  it("wrong password → WrongPassword", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    await expectCryptoError(unlockWithPassword(crypto, created.config, "wrong password 123"), "WrongPassword");
  });

  it("normalises unicode passwords (NFC vs NFD)", async () => {
    const pw = "Passwört-Müller-2026";
    const created = await createVault(crypto, pw.normalize("NFC"), { kdf: "pbkdf2-sha256" });
    await expect(unlockWithPassword(crypto, created.config, pw.normalize("NFD"))).resolves.toBeInstanceOf(VaultKeys);
  });

  it("rejects short passwords", async () => {
    await expect(createVault(crypto, "short")).rejects.toBeInstanceOf(CryptoError);
  });

  it("unlocks with recovery key and rejects wrong ones", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    expect(created.recoveryKey).not.toBeNull();
    const keys = await unlockWithRecoveryKey(crypto, created.config, created.recoveryKey as string);
    expect(toHex(keys.exportMasterKey())).toBe(toHex(created.keys.exportMasterKey()));
    await expectCryptoError(unlockWithRecoveryKey(crypto, created.config, formatRecoveryKey(crypto.randomBytes(32))), "WrongRecoveryKey");
  });

  it("master key is never contained in the public config", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const serialized = utf8Decode(serializeVaultConfig(created.config));
    const mk = created.keys.exportMasterKey();
    expect(serialized).not.toContain(toHex(mk));
    expect(serialized).not.toContain(toBase64(mk));
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain((created.recoveryKey as string).replace(/-/g, ""));
  });

  it("changing the password keeps the master key and invalidates the old password", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const newConfig = await changePassword(crypto, created.config, created.keys, "a completely new password");
    await expectCryptoError(unlockWithPassword(crypto, newConfig, PASSWORD), "WrongPassword");
    const keys = await unlockWithPassword(crypto, newConfig, "a completely new password");
    expect(toHex(keys.exportMasterKey())).toBe(toHex(created.keys.exportMasterKey()));
    // Recovery slot survives a password change.
    await expect(unlockWithRecoveryKey(crypto, newConfig, created.recoveryKey as string)).resolves.toBeInstanceOf(VaultKeys);
  });

  it("regenerating the recovery key invalidates the old one", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const { config, recoveryKey } = await regenerateRecoveryKey(crypto, created.config, created.keys);
    await expectCryptoError(unlockWithRecoveryKey(crypto, config, created.recoveryKey as string), "WrongRecoveryKey");
    await expect(unlockWithRecoveryKey(crypto, config, recoveryKey)).resolves.toBeInstanceOf(VaultKeys);
  });

  it("detects config manipulation via MAC", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const tampered = { ...created.config, keySlots: created.config.keySlots.filter((s) => s.type === "password") };
    await expectCryptoError(unlockWithPassword(crypto, tampered, PASSWORD), "ConfigIntegrity");
  });

  it("KDF parameter manipulation breaks unwrapping", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const slots = created.config.keySlots.map((s) =>
      s.type === "password" && s.kdf.algorithm === "pbkdf2-sha256" ? { ...s, kdf: { ...s.kdf, iterations: 310000 } } : s,
    );
    await expect(unlockWithPassword(crypto, { ...created.config, keySlots: slots }, PASSWORD)).rejects.toBeInstanceOf(CryptoError);
  });

  it("a master key of another vault is rejected (foreign vault)", async () => {
    const a = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const b = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    await expectCryptoError(unlockWithMasterKey(crypto, b.config, a.keys.exportMasterKey()), "ConfigIntegrity");
  });

  it("config serialisation round-trips through the strict parser", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    expect(parseVaultConfig(serializeVaultConfig(created.config))).toEqual(created.config);
  });

  it("lock removes keys from memory", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const manager = new KeyManager();
    manager.setKeys(created.keys);
    expect(manager.isUnlocked).toBe(true);
    manager.lock();
    expect(manager.isUnlocked).toBe(false);
    expect(() => manager.keys).toThrow(CryptoError);
    expect(() => created.keys.exportMasterKey()).toThrow(CryptoError);
  });
});

describe("encryption engine", () => {
  it("binds objects to their object id (swapping is detected)", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const engine = new EncryptionEngine(crypto, created.keys);
    const data = utf8Encode("Hallo Welt");
    const hash = await crypto.hash(data);
    const idA = "a".repeat(32);
    const idB = "b".repeat(32);
    const blob = await engine.encryptObject(idA, data);
    expect(await engine.decryptObject(idA, blob.bytes, hash)).toEqual(data);
    await expect(engine.decryptObject(idB, blob.bytes, hash)).rejects.toBeInstanceOf(CryptoError);
  });

  it("detects a stale object version via content hash", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const engine = new EncryptionEngine(crypto, created.keys);
    const id = "c".repeat(32);
    const blob = await engine.encryptObject(id, utf8Encode("old"));
    await expectCryptoError(engine.decryptObject(id, blob.bytes, await crypto.hash(utf8Encode("new"))), "IntegrityMismatch");
  });

  it("manifest keys differ from object keys", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const engine = new EncryptionEngine(crypto, created.keys);
    const blob = await engine.encryptManifest(utf8Encode("{}"));
    expect(await engine.decryptManifest(blob.bytes)).toEqual(utf8Encode("{}"));
    await expect(engine.decryptObject("d".repeat(32), blob.bytes, "")).rejects.toBeInstanceOf(CryptoError);
  });

  it("a vault with a different key can not decrypt", async () => {
    const a = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const b = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const blob = await new EncryptionEngine(crypto, a.keys).encryptManifest(utf8Encode("{}"));
    await expect(new EncryptionEngine(crypto, b.keys).decryptManifest(blob.bytes)).rejects.toBeInstanceOf(CryptoError);
  });
});
