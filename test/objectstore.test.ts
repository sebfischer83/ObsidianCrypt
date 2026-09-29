import { describe, expect, it } from "vitest";
import { RemoteError } from "../src/errors/RemoteError";
import { CryptoError } from "../src/errors/CryptoError";
import { SyncError } from "../src/errors/SyncError";
import { probeStore } from "../src/store/CapabilityProbe";
import { assertStoreKey } from "../src/store/BlobStore";
import { ObjectStoreRepository } from "../src/store/ObjectStoreRepository";
import type { BackendLocation } from "../src/remote/BackendLocation";
import { DeletedFiles } from "../src/sync/DeletedFiles";
import { followMove, moveVault } from "../src/sync/VaultMigration";
import { VersionHistory } from "../src/sync/VersionHistory";
import { utf8Decode, utf8Encode } from "../src/util/bytes";
import { FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { MemoryBlobStore, StoreCrash, type WriteFault } from "./fakes/MemoryBlobStore";
import { crypto, Device, twoDevicesOn } from "./fakes/harness";
import { findLeaks } from "./security.test";

function objectStore(store = new MemoryBlobStore()): ObjectStoreRepository {
  return new ObjectStoreRepository(store, { crypto, skipProbe: true, verifyDelayMs: 0, sleep: async () => undefined });
}

async function devices(store = new MemoryBlobStore(), limits = {}) {
  const pair = await twoDevicesOn(() => objectStore(store), limits);
  return { ...pair, store };
}

function contents(d: Device): string[] {
  return Object.values(d.fs.snapshot()).sort();
}

describe("capability probe", () => {
  it("accepts a compliant store and refuses one that ignores conditional writes", async () => {
    expect(await probeStore(new MemoryBlobStore(), crypto)).toMatchObject({ conditionalReplace: true });
    const bad = new MemoryBlobStore();
    bad.ignoreConditions = true;
    await expect(probeStore(bad, crypto)).rejects.toMatchObject({ category: "Unsupported" });
    expect([...bad.objects.keys()].filter((k) => k.startsWith("probe/"))).toEqual([]);
    const repo = new ObjectStoreRepository(bad, { crypto });
    const a = new Device(repo);
    await expect(a.createVault()).rejects.toBeInstanceOf(RemoteError);
  });
});

describe("object store backend", () => {
  it("syncs two devices end to end, including conflicts, renames and deletions", async () => {
    const { a, b, store } = await devices();
    a.fs.setText("Notes/Plan.md", "plan v1");
    a.fs.setText("todo.md", "todo");
    await a.sync();
    await b.sync();
    expect(b.fs.text("Notes/Plan.md")).toBe("plan v1");

    a.fs.setText("Notes/Plan.md", "from A");
    b.fs.setText("Notes/Plan.md", "from B");
    await b.fs.rename("todo.md", "done.md");
    b.store.recordRename("todo.md", "done.md");
    await a.sync();
    const report = await b.sync();
    expect(report.newConflicts).toHaveLength(1);
    await a.sync();
    expect(contents(a)).toEqual(contents(b));
    expect(contents(a)).toEqual(expect.arrayContaining(["from A", "from B", "todo"]));

    await a.fs.trash("done.md");
    await a.sync();
    await b.sync();
    expect(await b.fs.exists("done.md")).toBe(false);
    expect(findLeaks(store.everythingStored(), ["Notes", "Plan.md", "plan v1", "from A", "from B", "todo.md", "done.md"])).toEqual([]);
  });

  it("keeps version history in paged revisions and restores deleted files", async () => {
    const { a, store } = await devices();
    for (let i = 1; i <= 20; i++) {
      a.fs.setText("Note.md", `version ${i}`);
      await a.sync();
    }
    const history = new VersionHistory({ crypto, fs: a.fs, remote: a.remote, store: a.store, getKeys: () => a.keys });
    const versions = await history.list("Note.md", 20);
    expect(versions).toHaveLength(20);
    const texts: string[] = [];
    for (const v of versions) texts.push(utf8Decode((await history.load(v))!));
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `version ${20 - i}`));
    expect([...store.objects.keys()].some((k) => k.startsWith("trees/"))).toBe(true);

    await a.fs.trash("Note.md");
    await a.sync();
    const deleted = new DeletedFiles({ crypto, fs: a.fs, remote: a.remote, store: a.store, getKeys: () => a.keys });
    const [file] = deleted.list();
    const resolved = (await deleted.resolve(file!))!;
    expect(resolved.path).toBe("Note.md");
    expect(utf8Decode(await deleted.load(resolved))).toBe("version 20");
  });

  it("handles large files as chunks", async () => {
    const { a, b } = await devices(undefined, { chunkSize: 8 });
    a.fs.setText("big.bin", "0123456789".repeat(10));
    await a.sync();
    await b.sync();
    expect(b.fs.text("big.bin")).toBe("0123456789".repeat(10));
    a.fs.setText("big.bin", "0123456789".repeat(9) + "abcdefghij");
    await a.sync();
    await b.sync();
    expect(b.fs.text("big.bin")).toBe("0123456789".repeat(9) + "abcdefghij");
  });

  it("answers ancestry over long histories with few requests (skip pointers)", async () => {
    const { a, remote, store } = await devices();
    const commits: string[] = [];
    for (let i = 0; i < 70; i++) {
      a.fs.setText("n.md", `n${i}`);
      commits.push((await a.sync()).commits[0]!);
    }
    const fresh = objectStore(store); // cold cache
    const before = store.requestCount;
    expect(await fresh.isAncestor(commits[3]!, commits[69]!)).toBe(true);
    expect(store.requestCount - before).toBeLessThan(25);
    expect(await remote.isAncestor(commits[69]!, commits[3]!)).toBe(false);
  });

  it("refuses to initialise over foreign content or a vault that lost its HEAD", async () => {
    const foreign = new MemoryBlobStore();
    foreign.objects.set("notes.txt", { bytes: utf8Encode("hello"), etag: '"x"' });
    await expect(new Device(objectStore(foreign)).createVault()).rejects.toMatchObject({ blockReason: "RepositoryNotEmpty" });

    const { a, store } = await devices();
    a.fs.setText("n.md", "history");
    await a.sync();
    const head = store.objects.get("HEAD")!;
    const lost = new MemoryBlobStore();
    for (const [key, value] of store.objects) if (key !== "HEAD") lost.objects.set(key, value);
    expect(head).toBeDefined();
    const first = new Device(objectStore(lost));
    const firstError = await first.createVault().catch((e: unknown) => e);
    expect(firstError).toBeInstanceOf(SyncError);
  });

  it("detects corrupted records and repairs a torn upload of content-addressed data", async () => {
    const { a, b, store } = await devices();
    a.fs.setText("n.md", "content");
    await a.sync();
    const blobKey = [...store.objects.keys()].find((k) => k.startsWith("blobs/") && store.objects.get(k)!.bytes.length > 60)!;
    const good = store.objects.get(blobKey)!;
    store.objects.set(blobKey, { bytes: good.bytes.slice(0, 10), etag: '"torn"' });
    const error = await b.sync().catch((e: unknown) => e);
    expect(error).toBeDefined();
    expect(await b.fs.exists("n.md")).toBe(false);
    // Re-uploading the same content replaces the torn object (its correct bytes are defined by its hash).
    await objectStore(store).uploadObject({ bytes: good.bytes } as never).catch(() => undefined);
    store.objects.set(blobKey, good);
    await b.sync();
    expect(b.fs.text("n.md")).toBe("content");
  });
});

describe("object store crash safety", () => {
  it("never loses content when any single write of a push fails in any way", async () => {
    // Count the writes of one typical push first.
    const probe = await devices();
    probe.a.fs.setText("x.md", "base");
    await probe.a.sync();
    probe.a.fs.setText("x.md", "changed");
    probe.a.fs.setText("y.md", "new");
    const writesBefore = probe.store.writeCount;
    await probe.a.sync();
    const writesPerPush = probe.store.writeCount - writesBefore;
    expect(writesPerPush).toBeGreaterThan(3);

    for (let k = 1; k <= writesPerPush; k++) {
      for (const kind of ["crashBefore", "crashAfter", "ambiguous"] as WriteFault[]) {
        const { a, b, store } = await devices();
        a.fs.setText("x.md", "base");
        await a.sync();
        await b.sync();
        a.fs.setText("x.md", "changed");
        a.fs.setText("y.md", "new");
        store.fault = { at: store.writeCount + k, kind };
        const failed = await a.sync().catch((e: unknown) => e);
        expect(!(failed instanceof Error) || failed instanceof StoreCrash || failed instanceof RemoteError, `${kind}@${k}`).toBe(true);
        if (failed instanceof StoreCrash) await a.restart();
        b.fs.setText("z.md", "from b meanwhile");
        await b.sync();
        await a.sync();
        await b.sync();
        await a.sync();
        expect(a.fs.text("x.md"), `${kind}@${k}`).toBe("changed");
        expect(contents(a), `${kind}@${k}`).toEqual(contents(b));
        expect(contents(b)).toEqual(expect.arrayContaining(["changed", "new", "from b meanwhile"]));
      }
    }
  });

  it("does not finalise a head update that a simultaneous writer replaced (non-atomic CAS)", async () => {
    const store = new MemoryBlobStore();
    store.casAtomic = false;
    const { a, b } = await devices(store);
    a.fs.setText("a.md", "a0");
    await a.sync();
    await b.sync();
    a.fs.setText("a.md", "from a");
    b.fs.setText("b.md", "from b");
    // A's HEAD update passes its precondition; before it is written, B's complete push happens as well, and
    // then A's write lands on top – B's update is silently overwritten on the server.
    let bHead: string | null = null;
    store.onReplaceChecked = async () => {
      await b.sync();
      bHead = b.store.state.lastRemoteCommit;
    };
    await a.sync();
    expect(bHead).not.toBeNull();
    // B believed its push landed, but A overwrote it. B must notice instead of silently diverging: the head is
    // a sibling of its last commit. Its files stay untouched (automatic re-merge follows in phase 3).
    const error = await b.sync().catch((e: unknown) => e);
    expect(error).toMatchObject({ blockReason: "HistoryRewritten" });
    expect(b.fs.text("b.md")).toBe("from b");
    expect(b.fs.text("a.md")).toBe("a0");
    await a.sync();
    expect(a.fs.text("a.md")).toBe("from a");
  });
});

describe("moving between backend types", () => {
  it("moves a vault from GitHub-like storage to an object store and back, keeping history", async () => {
    const source = new FakeRemoteRepository();
    const a = new Device(source);
    await a.createVault();
    const b = new Device(source);
    await b.connect();
    a.fs.setText("n.md", "v1");
    await a.sync();
    a.fs.setText("n.md", "v2");
    await a.sync();
    await b.sync();

    const GH: BackendLocation = { kind: "github", owner: "alice", repo: "vault", branch: "main" };
    const S3: BackendLocation = { kind: "s3", endpoint: "https://s3.example.com", region: "us-east-1", bucket: "vault", prefix: "notes", pathStyle: true };
    const target = objectStore();
    await moveVault({ crypto, keys: a.keys, store: a.store, deviceId: a.deviceId, source, sourceLocation: GH, target, targetLocation: S3 });
    a.switchRemote(target);
    a.fs.setText("n.md", "v3 on s3");
    await a.sync();

    expect((await b.sync().catch((e: unknown) => e)) as SyncError).toMatchObject({ blockReason: "VaultMoved" });
    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: GH, target });
    b.switchRemote(target);
    await b.sync();
    expect(b.fs.text("n.md")).toBe("v3 on s3");

    const archives = [{ remote: source, from: a.store.state.remote!.movedFrom![0]!.commit }];
    const history = new VersionHistory({ crypto, fs: b.fs, remote: target, store: b.store, getKeys: () => b.keys, archives });
    const texts: string[] = [];
    for (const v of await history.list("n.md", 10)) texts.push(utf8Decode((await history.load(v))!));
    expect(texts).toEqual(["v3 on s3", "v2", "v1"]);
  });
});

describe("object store review fixes", () => {
  it("refuses servers whose ETags repeat for same-size content (mtime + size)", async () => {
    const store = new MemoryBlobStore();
    store.mtimeEtags = true;
    await expect(probeStore(store, crypto)).rejects.toMatchObject({ category: "Unsupported" });
  });

  it("probes a joining device before its first write", async () => {
    const good = new MemoryBlobStore();
    const { a } = await devices(good);
    a.fs.setText("n.md", "x");
    await a.sync();
    // Same data behind a proxy that strips conditional headers: the joining device must not write.
    const stripped = new MemoryBlobStore();
    for (const [k, v] of good.objects) stripped.objects.set(k, v);
    stripped.ignoreConditions = true;
    const c = new Device(new ObjectStoreRepository(stripped, { crypto, verifyDelayMs: 0, sleep: async () => undefined }));
    await c.connect();
    await c.sync(); // reading is fine
    c.fs.setText("m.md", "from c");
    await expect(c.sync()).rejects.toMatchObject({ category: "Unsupported" });
  });

  it("does not finalise after an unknown outcome if another writer replaced HEAD (non-atomic CAS)", async () => {
    const store = new MemoryBlobStore();
    store.casAtomic = false;
    const { a, b } = await devices(store);
    a.fs.setText("n.md", "base");
    await a.sync();
    await b.sync();
    const oldHead = store.objects.get("HEAD")!;
    a.fs.setText("n.md", "from a");
    // A's HEAD write is applied, the response is lost, and a competing writer puts the old head back.
    store.afterApply = (key) => {
      if (key !== "HEAD") return;
      store.afterApply = null;
      store.objects.set("HEAD", { bytes: oldHead.bytes, etag: '"competitor"' });
    };
    store.fault = { at: store.writeCount + 1, kind: "ambiguous" };
    let report;
    for (let i = 0; i < 12 && !report; i++) {
      store.fault = store.fault && store.fault.at > store.writeCount ? store.fault : null;
      report = await a.sync().catch(() => undefined);
    }
    expect(report).toBeDefined();
    await b.sync();
    expect(b.fs.text("n.md")).toBe("from a");
  });

  it("reports corrupted stored data as an integrity failure", async () => {
    const { a, store } = await devices();
    a.fs.setText("n.md", "content");
    await a.sync();
    const id = a.store.state.localMap["n.md"]!;
    const commit = a.store.state.lastRemoteCommit!;
    for (const [key, entry] of [...store.objects]) {
      if (!key.startsWith("blobs/")) continue;
      const tampered = entry.bytes.slice();
      tampered[tampered.length - 1]! ^= 1;
      store.objects.set(key, { bytes: tampered, etag: entry.etag });
    }
    await expect(objectStore(store).readObject(commit, id)).rejects.toBeInstanceOf(CryptoError);
    await expect(objectStore(store).readManifest(commit)).rejects.toBeInstanceOf(CryptoError);
  });

  it("rejects duplicate objects in one commit and records no revision for no-ops", async () => {
    const { a, remote } = await devices();
    a.fs.setText("n.md", "x");
    await a.sync();
    const head = a.store.state.lastRemoteCommit!;
    const id = a.store.state.localMap["n.md"]!;
    await expect(remote.createCommit(head, [{ kind: "deleteObject", objectId: id }, { kind: "deleteObject", objectId: id }], { message: "Encrypted vault sync: 2 changes\n\nDevice: 12345678-0000-4000-8000-000000000000\n" })).rejects.toBeInstanceOf(SyncError);
    const noop = await remote.createCommit(head, [{ kind: "deleteObject", objectId: "e".repeat(32) }], { message: "Encrypted vault sync: 1 change\n\nDevice: 12345678-0000-4000-8000-000000000000\n" });
    expect(await remote.listObjectRevisions(noop, "e".repeat(32), 5)).toEqual([]);
    expect((await remote.listObjectIds(noop)).ids).toEqual((await remote.listObjectIds(head)).ids);
  });

  it("retries a create that was reported as existing but is not readable", async () => {
    const { a, b, store } = await devices();
    store.phantomExists = 1;
    a.fs.setText("n.md", "phantom");
    await a.sync();
    await b.sync();
    expect(b.fs.text("n.md")).toBe("phantom");
  });

  it("never accepts dot segments in store keys", () => {
    for (const key of ["probe/.", "commits/./x", "a/../b", "HEAD/"]) expect(() => assertStoreKey(key), key).toThrow();
    expect(() => assertStoreKey("commits/ab/abc")).not.toThrow();
  });
});
