import { beforeAll, describe, expect, it } from "vitest";
import { EncryptionEngine } from "../../src/crypto/EncryptionEngine";
import { createVault, type CreatedVault } from "../../src/crypto/KeyManager";
import { RemoteError } from "../../src/errors/RemoteError";
import { SyncError } from "../../src/errors/SyncError";
import { buildCommitMessage, buildMigrationMessage } from "../../src/remote/RemoteLayout";
import type { RemoteChange, RemoteRepository } from "../../src/remote/RemoteRepository";
import { utf8Encode } from "../../src/util/bytes";
import { crypto, PASSWORD } from "./harness";

const DEVICE = "12345678-0000-4000-8000-000000000000";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

/**
 * The contract every backend's RemoteRepository must fulfil – the sync engine relies on exactly these git-like
 * semantics (snapshots per commit, single-parent history, compare-and-swap head, per-object revisions).
 */
export function remoteConformance(name: string, fresh: () => Promise<RemoteRepository>): void {
  describe(`RemoteRepository conformance: ${name}`, () => {
    let vault: CreatedVault;
    let engine: EncryptionEngine;
    beforeAll(async () => {
      vault = await createVault(crypto, PASSWORD, { kdf: "pbkdf2-sha256", withRecoveryKey: false });
      engine = new EncryptionEngine(crypto, vault.keys);
    });
    const object = async (id: string, text: string): Promise<RemoteChange> => ({ kind: "putObject", objectId: id, blob: await engine.encryptObject(id, utf8Encode(text)) });
    const manifest = async (text: string): Promise<RemoteChange> => ({ kind: "putManifest", blob: await engine.encryptManifest(utf8Encode(text)) });
    const read = async (remote: RemoteRepository, commit: string, id: string): Promise<string> =>
      new TextDecoder().decode(await engine.decryptObjectRevision(id, await remote.readObject(commit, id)));
    const init = async (remote: RemoteRepository): Promise<string> => remote.initialize(vault.config, { message: `Initialize encrypted vault\n\nDevice: ${DEVICE}\n` });
    const push = async (remote: RemoteRepository, parent: string, changes: RemoteChange[], message = buildCommitMessage(changes.length, DEVICE)): Promise<string> => {
      const commit = await remote.createCommit(parent, changes, { message });
      await remote.updateHead(parent, commit);
      return commit;
    };

    it("starts empty and initialises exactly once", async () => {
      const remote = await fresh();
      expect(await remote.getHead()).toEqual({ kind: "empty" });
      const root = await init(remote);
      expect(await remote.getHead()).toEqual({ kind: "ok", commit: root });
      expect(await remote.readConfig(root)).not.toBeNull();
      expect(await remote.readManifest(root)).toBeNull();
      expect(await remote.isBootstrapCommit(root)).toBe(true);
      expect(await remote.hasAnyFiles(root)).toBe(true);
      expect(await remote.getParents(root)).toEqual([]);
      await expect(init(remote)).rejects.toMatchObject({ code: "ConcurrentRemoteUpdate" });
    });

    it("keeps immutable snapshots per commit and moves the head only via updateHead", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const c1 = await remote.createCommit(root, [await object(A, "a1"), await object(B, "b1"), await manifest("m1")], { message: buildCommitMessage(2, DEVICE) });
      expect(await remote.getHead()).toEqual({ kind: "ok", commit: root });
      await remote.updateHead(root, c1);
      const c2 = await push(remote, c1, [await object(A, "a2"), { kind: "deleteObject", objectId: B }, await manifest("m2")]);
      expect(await read(remote, c1, A)).toBe("a1");
      expect(await read(remote, c2, A)).toBe("a2");
      expect(await read(remote, c1, B)).toBe("b1");
      await expect(remote.readObject(c2, B)).rejects.toMatchObject({ category: "NotFound" });
      await expect(remote.readObject(c2, C)).rejects.toBeInstanceOf(RemoteError);
      expect(new TextDecoder().decode(await engine.decryptManifest((await remote.readManifest(c1))!))).toBe("m1");
      expect(await remote.isBootstrapCommit(c2)).toBe(false);
      expect(await remote.getParents(c2)).toEqual([c1]);
      expect((await remote.listObjectIds(c2)).ids).toEqual([A]);
      expect((await remote.listObjectIds(c1)).ids.sort()).toEqual([A, B]);
    });

    it("updates the head by compare-and-swap only", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const c1 = await push(remote, root, [await object(A, "a1"), await manifest("m1")]);
      const loser = await remote.createCommit(root, [await object(A, "other"), await manifest("mx")], { message: buildCommitMessage(1, DEVICE) });
      await expect(remote.updateHead(root, loser)).rejects.toMatchObject({ code: "ConcurrentRemoteUpdate" });
      expect(await remote.getHead()).toEqual({ kind: "ok", commit: c1 });
      // Repeating an update that already landed is not an error.
      await remote.updateHead(root, c1);
      expect(await remote.getHead()).toEqual({ kind: "ok", commit: c1 });
    });

    it("answers ancestry questions", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const c1 = await push(remote, root, [await object(A, "1"), await manifest("m")]);
      const c2 = await push(remote, c1, [await object(A, "2"), await manifest("m")]);
      const orphan = await remote.createCommit(c1, [await object(B, "x"), await manifest("m")], { message: buildCommitMessage(1, DEVICE) });
      expect(await remote.isAncestor(root, c2)).toBe(true);
      expect(await remote.isAncestor(c1, c2)).toBe(true);
      expect(await remote.isAncestor(c2, c2)).toBe(true);
      expect(await remote.isAncestor(c2, c1)).toBe(false);
      expect(await remote.isAncestor(orphan, c2)).toBe(false);
      expect(await remote.isAncestor("f".repeat(40), c2)).toBe(false);
    });

    it("lists revisions of one object newest first, including its deletion", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const c1 = await push(remote, root, [await object(A, "1"), await manifest("m")]);
      const c2 = await push(remote, c1, [await object(B, "other"), await manifest("m")]);
      const c3 = await push(remote, c2, [await object(A, "3"), await manifest("m")], buildMigrationMessage(1, DEVICE));
      const c4 = await push(remote, c3, [{ kind: "deleteObject", objectId: A }, await manifest("m")]);
      const revisions = await remote.listObjectRevisions(c4, A, 10);
      expect(revisions.map((r) => r.commit)).toEqual([c4, c3, c1]);
      expect(revisions.map((r) => r.migration)).toEqual([false, true, false]);
      expect(revisions.every((r) => r.device === DEVICE)).toBe(true);
      expect((await remote.listObjectRevisions(c4, A, 2)).map((r) => r.commit)).toEqual([c4, c3]);
      expect((await remote.listObjectRevisions(c2, A, 10)).map((r) => r.commit)).toEqual([c1]);
      expect(await remote.listObjectRevisions(c4, C, 10)).toEqual([]);
    });

    it("commits objects uploaded beforehand and ignores unused uploads", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const handle = await remote.uploadObject(await engine.encryptObject(A, utf8Encode("uploaded")));
      await remote.uploadObject(await engine.encryptObject(B, utf8Encode("never committed")));
      const c1 = await push(remote, root, [{ kind: "putUploadedObject", objectId: A, handle }, await manifest("m")]);
      expect(await read(remote, c1, A)).toBe("uploaded");
      expect((await remote.listObjectIds(c1)).ids).toEqual([A]);
    });

    it("replaces the config", async () => {
      const remote = await fresh();
      const root = await init(remote);
      const before = await remote.readConfig(root);
      const c1 = await push(remote, root, [{ kind: "putConfig", config: vault.config }, await manifest("m")]);
      expect(await remote.readConfig(c1)).toEqual(before);
      expect(SyncError).toBeDefined();
    });
  });
}
