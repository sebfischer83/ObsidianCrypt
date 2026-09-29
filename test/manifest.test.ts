import { describe, expect, it } from "vitest";
import { createVault } from "../src/crypto/KeyManager";
import { EncryptionEngine } from "../src/crypto/EncryptionEngine";
import { SyncError } from "../src/errors/SyncError";
import { MANIFEST_TYPE, type Manifest } from "../src/manifest/Manifest";
import { decodeManifest, encodeManifest } from "../src/manifest/ManifestCodec";
import { utf8Encode } from "../src/util/bytes";
import { crypto, PASSWORD } from "./fakes/harness";

const VAULT = "0123456789abcdef0123456789abcdef";
const DEVICE = "19d359f8-0000-4000-8000-000000000000";
const HASH = "a".repeat(64);

function sample(): Manifest {
  return {
    type: MANIFEST_TYPE,
    formatVersion: 1,
    vaultId: VAULT,
    version: 18,
    parentCommit: "b".repeat(40),
    device: DEVICE,
    updatedAt: 1790428123000,
    entries: {
      ["13ac".padEnd(32, "0")]: { path: "Projekte/Projekt A.md", size: 18372, contentHash: HASH, modified: 1790428123000, updatedAtVersion: 17, updatedBy: DEVICE },
      ["91fd".padEnd(32, "0")]: { path: "Attachments/Bild.png", size: 938712, contentHash: HASH, modified: 1790428231000, updatedAtVersion: 18, updatedBy: DEVICE },
      ["77e0".padEnd(32, "0")]: { deleted: true, deletedAtVersion: 52, deletedBy: DEVICE },
    },
  };
}

function expectBlocked(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).blockReason).toBe(reason);
    return;
  }
  throw new Error("expected SyncError");
}

describe("manifest", () => {
  it("serialize → encrypt → decrypt → deserialize", async () => {
    const created = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256" });
    const engine = new EncryptionEngine(crypto, created.keys);
    const manifest = { ...sample(), vaultId: created.config.vaultId };
    const blob = await engine.encryptManifest(encodeManifest(manifest));
    expect(decodeManifest(await engine.decryptManifest(blob.bytes), created.config.vaultId)).toEqual(manifest);
  });

  it("serialisation is deterministic", () => {
    const a = sample();
    const b: Manifest = { ...a, entries: Object.fromEntries(Object.entries(a.entries).reverse()) };
    expect(encodeManifest(a)).toEqual(encodeManifest(b));
  });

  it("rejects path traversal and invalid paths", () => {
    for (const path of ["../evil.md", "/abs.md", "a//b.md", "a/./b.md", "C:/x.md", "a\u0000b.md", "a\\b.md", ""]) {
      const m = sample();
      const bad = { ...m, entries: { ["1".repeat(32)]: { path, size: 1, contentHash: HASH, modified: 0, updatedAtVersion: 1, updatedBy: DEVICE } } };
      expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify(bad)), VAULT), "ManifestCorrupted");
    }
  });

  it("rejects duplicate paths (case-insensitive)", () => {
    const m = sample();
    const bad = {
      ...m,
      entries: {
        ["1".repeat(32)]: { path: "Note.md", size: 1, contentHash: HASH, modified: 0, updatedAtVersion: 1, updatedBy: DEVICE },
        ["2".repeat(32)]: { path: "note.md", size: 1, contentHash: HASH, modified: 0, updatedAtVersion: 1, updatedBy: DEVICE },
      },
    };
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify(bad)), VAULT), "ManifestCorrupted");
  });

  it("rejects unknown fields, foreign vaults and newer formats", () => {
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...sample(), extra: 1 })), VAULT), "ManifestCorrupted");
    expectBlocked(() => decodeManifest(encodeManifest(sample()), "f".repeat(32)), "ForeignVault");
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...sample(), formatVersion: 5 })), VAULT), "UnknownFormatVersion");
    expectBlocked(() => decodeManifest(utf8Encode("not json"), VAULT), "ManifestCorrupted");
  });

  it("tombstones carry no path or hash", () => {
    const m = sample();
    const bad = { ...m, entries: { ["1".repeat(32)]: { deleted: true, deletedAtVersion: 1, deletedBy: DEVICE, path: "x.md" } } };
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify(bad)), VAULT), "ManifestCorrupted");
  });
});

describe("manifest format 2 (chunked objects)", () => {
  it("still reads format 1 manifests and validates the chunk count", () => {
    const m = sample();
    expect(decodeManifest(utf8Encode(JSON.stringify({ ...m, formatVersion: 1 })), VAULT).formatVersion).toBe(1);
    const id = "1".repeat(32);
    const live = { path: "big.bin", size: 10, contentHash: "a".repeat(64), modified: 1, updatedAtVersion: 1, updatedBy: DEVICE };
    const withChunks = decodeManifest(utf8Encode(JSON.stringify({ ...m, entries: { [id]: { ...live, chunks: 3 } } })), VAULT);
    expect(withChunks.entries[id]).toEqual({ ...live, chunks: 3 });
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...m, entries: { [id]: { ...live, chunks: 0 } } })), VAULT), "ManifestCorrupted");
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...m, entries: { [id]: { ...live, chunks: 1.5 } } })), VAULT), "ManifestCorrupted");
  });
});

describe("manifest format 3 (moved vaults)", () => {
  it("accepts move fields only with format 3 and validates repository names", () => {
    const m = { ...sample(), formatVersion: 3 };
    const movedTo = { owner: "alice", repo: "vault-2", branch: "main" };
    const movedFrom = [{ owner: "alice", repo: "vault", branch: "main", commit: "a".repeat(40) }];
    expect(decodeManifest(utf8Encode(JSON.stringify({ ...m, movedTo, movedFrom })), VAULT)).toMatchObject({ movedTo, movedFrom });
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...m, formatVersion: 2, movedTo })), VAULT), "ManifestCorrupted");
    for (const bad of [
      { ...movedTo, owner: "-x" },
      { ...movedTo, repo: ".." },
      { ...movedTo, repo: "a/b" },
      { ...movedTo, branch: "a..b" },
      { ...movedTo, extra: 1 },
    ]) {
      expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...m, movedTo: bad })), VAULT), "ManifestCorrupted");
    }
  });
});

describe("manifest format 4 (config binding)", () => {
  it("requires the config hash from format 4 on and rejects it before", () => {
    const hash = "e".repeat(64);
    expect(decodeManifest(utf8Encode(JSON.stringify({ ...sample(), formatVersion: 4, configHash: hash })), VAULT).configHash).toBe(hash);
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...sample(), formatVersion: 4 })), VAULT), "ManifestCorrupted");
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...sample(), formatVersion: 3, configHash: hash })), VAULT), "ManifestCorrupted");
    expectBlocked(() => decodeManifest(utf8Encode(JSON.stringify({ ...sample(), formatVersion: 4, configHash: "xyz" })), VAULT), "ManifestCorrupted");
  });
});
