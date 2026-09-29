import { describe, expect, it } from "vitest";
import { isLive, type LiveEntry } from "../src/manifest/Manifest";
import { SyncError } from "../src/errors/SyncError";
import { GitHubError } from "../src/errors/GitHubError";
import { CryptoError } from "../src/errors/CryptoError";
import { CONFIG_PATH, MANIFEST_PATH } from "../src/remote/RemoteLayout";
import { changeVaultPassword } from "../src/sync/VaultSetup";
import { utf8Encode } from "../src/util/bytes";
import { CrashError, FakeRemoteRepository, type CrashPoint } from "./fakes/FakeRemoteRepository";
import { crypto, Device, PASSWORD, twoDevices } from "./fakes/harness";

function liveEntries(device: Device): Array<[string, LiveEntry]> {
  const remote = device.store.state.remote;
  if (!remote) return [];
  return Object.entries(remote.entries).filter((e): e is [string, LiveEntry] => isLive(e[1]));
}

function idOf(device: Device, path: string): string | undefined {
  return liveEntries(device).find(([, e]) => e.path === path)?.[0];
}

function conflictFiles(device: Device): string[] {
  return device.fs.paths().filter((p) => p.includes("(conflict "));
}

async function expectBlocked(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SyncError);
  expect((error as SyncError).blockReason).toBe(reason);
}

describe("MVP (§57)", () => {
  it("device A uploads, device B reconstructs, changes flow back", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    await a.createVault();
    const image = crypto.randomBytes(50_000);
    a.fs.setText("Test.md", "Hallo Welt");
    a.fs.setBytes("Bild.png", image);
    const first = await a.sync();
    expect(first.uploaded).toBe(2);

    const b = new Device(remote);
    await b.connect();
    await b.sync();
    expect(b.fs.text("Test.md")).toBe("Hallo Welt");
    expect(b.fs.bytes("Bild.png")).toEqual(image);

    b.fs.setText("Test.md", "Hallo Welt 2");
    await b.sync();
    await a.sync();
    expect(a.fs.text("Test.md")).toBe("Hallo Welt 2");
    expect(conflictFiles(a)).toEqual([]);
    expect(conflictFiles(b)).toEqual([]);
  });
});

describe("single device changes", () => {
  it("local create / modify / delete / rename propagate", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    a.fs.setText("Other.md", "other");
    await a.sync();
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "Note.md": "v1", "Other.md": "other" });

    a.fs.setText("Note.md", "v2");
    await a.sync();
    await b.sync();
    expect(b.fs.text("Note.md")).toBe("v2");

    a.fs.remove("Other.md");
    await a.sync();
    await b.sync();
    expect(await b.fs.exists("Other.md")).toBe(false);
    expect(b.fs.trashed.map((t) => t.path)).toContain("Other.md");

    const idBefore = idOf(a, "Note.md");
    a.fs.move("Note.md", "Archiv/Projekt 2026.md");
    a.store.recordRename("Note.md", "Archiv/Projekt 2026.md");
    const rename = await a.sync();
    expect(rename.uploaded).toBe(0); // rename re-uses the object, only the manifest changes
    expect(idOf(a, "Archiv/Projekt 2026.md")).toBe(idBefore);
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "Archiv/Projekt 2026.md": "v2" });
  });

  it("detects renames without events by content hash", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("x.md", "unique content");
    await a.sync();
    const id = idOf(a, "x.md");
    a.fs.move("x.md", "folder/y.md");
    const report = await a.sync();
    expect(report.uploaded).toBe(0);
    expect(idOf(a, "folder/y.md")).toBe(id);
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "folder/y.md": "unique content" });
  });

  it("keeps identity for rename + edit via rename events", async () => {
    const { a } = await twoDevices();
    a.fs.setText("a.md", "one");
    await a.sync();
    const id = idOf(a, "a.md");
    a.fs.move("a.md", "b.md");
    a.store.recordRename("a.md", "b.md");
    a.fs.setText("b.md", "two");
    await a.sync();
    expect(idOf(a, "b.md")).toBe(id);
  });

  it("folder renames keep identities", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Old/one.md", "1");
    a.fs.setText("Old/two.md", "2");
    await a.sync();
    const ids = [idOf(a, "Old/one.md"), idOf(a, "Old/two.md")];
    a.fs.move("Old/one.md", "New/one.md");
    a.fs.move("Old/two.md", "New/two.md");
    a.store.recordRename("Old", "New");
    const report = await a.sync();
    expect(report.uploaded).toBe(0);
    expect([idOf(a, "New/one.md"), idOf(a, "New/two.md")]).toEqual(ids);
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "New/one.md": "1", "New/two.md": "2" });
  });

  it("handles binary files of all kinds", async () => {
    const { a, b } = await twoDevices();
    const files: Record<string, Uint8Array> = {
      "a.png": crypto.randomBytes(1000),
      "b.pdf": crypto.randomBytes(3000),
      "c.mp3": crypto.randomBytes(5000),
      "d.mp4": crypto.randomBytes(7000),
      "e.zip": crypto.randomBytes(100),
      "f.canvas": utf8Encode('{"nodes":[]}'),
      "g.jpg": new Uint8Array(0),
    };
    for (const [p, d] of Object.entries(files)) a.fs.setBytes(p, d);
    await a.sync();
    await b.sync();
    for (const [p, d] of Object.entries(files)) expect(b.fs.bytes(p)).toEqual(d);
  });

  it("case-only rename is propagated", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("note.md", "x");
    await a.sync();
    await b.sync();
    a.fs.move("note.md", "Note.md");
    a.store.recordRename("note.md", "Note.md");
    await a.sync();
    await b.sync();
    expect(b.fs.paths()).toEqual(["Note.md"]);
  });
});

describe("incremental sync (§50)", () => {
  it("one modified note reads, uploads and downloads exactly one object", async () => {
    const { a, b, remote } = await twoDevices();
    for (let i = 0; i < 200; i++) a.fs.setText(`n/${i}.md`, `note ${i}`);
    await a.sync();
    await b.sync();
    a.fs.setText("n/42.md", "changed");
    const readsBefore = a.fs.readCount;
    const report = await a.sync();
    expect(report.uploaded).toBe(1);
    expect(a.fs.readCount - readsBefore).toBeLessThanOrEqual(3); // hash + upload read (+ignore file check)
    const downloadsBefore = remote.objectReads;
    const pull = await b.sync();
    expect(pull.downloaded).toBe(1);
    expect(remote.objectReads - downloadsBefore).toBe(1);
    expect(b.fs.text("n/42.md")).toBe("changed");
  });

  it("an unchanged vault needs a single remote request", async () => {
    const { a, remote } = await twoDevices();
    a.fs.setText("x.md", "x");
    await a.sync();
    const before = remote.requestCount;
    await a.sync();
    expect(remote.requestCount - before).toBe(1);
  });

  it("splits large uploads into several commits", async () => {
    const { a, b } = await twoDevices({ maxFilesPerCommit: 3 });
    for (let i = 0; i < 10; i++) a.fs.setText(`f${i}.md`, `${i}`);
    const report = await a.sync();
    expect(report.commits.length).toBe(4);
    expect(report.uploaded).toBe(10);
    await b.sync();
    expect(b.fs.paths().length).toBe(10);
  });
});

describe("conflicts (§21–§23, §58)", () => {
  it("simultaneous modify keeps both versions", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Test.md", "Version 1");
    await a.sync();
    await b.sync();
    a.fs.setText("Test.md", "Version A");
    b.fs.setText("Test.md", "Version B");
    await b.sync();
    const report = await a.sync();
    expect(report.newConflicts).toHaveLength(1);
    expect(a.fs.text("Test.md")).toBe("Version B");
    const copies = conflictFiles(a);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^Test \(conflict \d{4}-\d{2}-\d{2} [0-9a-f]{8}\)\.md$/);
    expect(a.fs.text(copies[0] as string)).toBe("Version A");
    await b.sync();
    expect(b.fs.snapshot()).toEqual(a.fs.snapshot());
  });

  it("local delete vs remote modify restores the modified version", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.remove("n.md");
    b.fs.setText("n.md", "v2");
    await b.sync();
    const report = await a.sync();
    expect(a.fs.text("n.md")).toBe("v2");
    expect(report.newConflicts.map((c) => c.kind)).toEqual(["localDeleteRemoteModify"]);
    await b.sync();
    expect(b.fs.text("n.md")).toBe("v2");
  });

  it("local modify vs remote delete keeps the modified version everywhere", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.remove("n.md");
    await a.sync();
    b.fs.setText("n.md", "v2 edited offline");
    const report = await b.sync();
    expect(report.newConflicts.map((c) => c.kind)).toEqual(["localModifyRemoteDelete"]);
    expect(b.fs.text("n.md")).toBe("v2 edited offline");
    await a.sync();
    expect(a.fs.text("n.md")).toBe("v2 edited offline");
  });

  it("both created the same path with different content", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Idea.md", "from A");
    b.fs.setText("Idea.md", "from B");
    await a.sync();
    const report = await b.sync();
    expect(report.newConflicts.map((c) => c.kind)).toEqual(["bothCreated"]);
    expect(b.fs.text("Idea.md")).toBe("from A");
    expect(conflictFiles(b).map((p) => b.fs.text(p))).toEqual(["from B"]);
    await a.sync();
    expect(a.fs.snapshot()).toEqual(b.fs.snapshot());
  });

  it("identical files created on both devices are merged without copies", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Same.md", "same");
    b.fs.setText("Same.md", "same");
    await a.sync();
    const report = await b.sync();
    expect(report.newConflicts).toHaveLength(0);
    expect(b.fs.paths()).toEqual(["Same.md"]);
    expect(liveEntries(b)).toHaveLength(1);
  });

  it("local rename + remote edit merge cleanly", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.move("n.md", "renamed.md");
    a.store.recordRename("n.md", "renamed.md");
    b.fs.setText("n.md", "v2");
    await b.sync();
    const report = await a.sync();
    expect(report.newConflicts).toHaveLength(0);
    expect(a.fs.snapshot()).toEqual({ "renamed.md": "v2" });
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "renamed.md": "v2" });
  });

  it("remote rename cycle (swap) is applied", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("A.md", "content A");
    a.fs.setText("B.md", "content B");
    await a.sync();
    await b.sync();
    a.fs.move("A.md", "tmp.md");
    a.fs.move("B.md", "A.md");
    a.fs.move("tmp.md", "B.md");
    a.store.recordRename("A.md", "tmp.md");
    a.store.recordRename("B.md", "A.md");
    a.store.recordRename("tmp.md", "B.md");
    await a.sync();
    await b.sync();
    expect(b.fs.snapshot()).toEqual({ "A.md": "content B", "B.md": "content A" });
  });

  it("never overwrites a file edited while it is being downloaded", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.setText("n.md", "v2 from A");
    await a.sync();
    remote.onReadObject = () => {
      remote.onReadObject = null;
      b.fs.setText("n.md", "typed on B during download");
    };
    await b.sync();
    expect(b.fs.text("n.md")).toBe("typed on B during download");
    await b.sync();
    const all = Object.values(b.fs.snapshot()).sort();
    expect(all).toEqual(["typed on B during download", "v2 from A"]);
  });
});

describe("concurrency (§48–§49)", () => {
  it("two devices pushing simultaneously lose nothing", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("a.md", "from A");
    b.fs.setText("b.md", "from B");
    remote.beforeUpdateHead = async () => {
      await b.sync(); // B wins the race while A is between commit creation and ref update
    };
    const report = await a.sync();
    expect(report.commits.length).toBe(1);
    await b.sync();
    expect(a.fs.snapshot()).toEqual({ "a.md": "from A", "b.md": "from B" });
    expect(b.fs.snapshot()).toEqual({ "a.md": "from A", "b.md": "from B" });
  });

  it("offline devices converge through tombstones", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("old.md", "x");
    await a.sync();
    await b.sync();
    a.fs.remove("old.md");
    await a.sync();
    // B was offline for a long time and still has the unchanged file: it must NOT re-upload it.
    await b.sync();
    expect(await b.fs.exists("old.md")).toBe(false);
    await a.sync();
    expect(await a.fs.exists("old.md")).toBe(false);
    const tombstones = Object.values(a.store.state.remote?.entries ?? {}).filter((e) => !isLive(e));
    expect(tombstones).toHaveLength(1);
  });
});

describe("offline operation (§34–§35)", () => {
  it("local vault stays untouched while offline and syncs afterwards", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    remote.offline = true;
    a.fs.setText("n.md", "offline edit");
    await expect(a.sync()).rejects.toBeInstanceOf(GitHubError);
    expect(a.fs.text("n.md")).toBe("offline edit");
    expect(await a.engine.countPendingChanges()).toBe(1);
    remote.offline = false;
    await a.sync();
    await b.sync();
    expect(b.fs.text("n.md")).toBe("offline edit");
  });

  it("locked vault refuses to sync", async () => {
    const { a } = await twoDevices();
    a.keys.destroy();
    await expect(a.sync()).rejects.toBeInstanceOf(CryptoError);
  });
});

describe("exclusions are never deletions", () => {
  it("files too large on one device stay on the remote", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    await a.createVault();
    a.fs.setBytes("big.bin", crypto.randomBytes(5000));
    a.fs.setText("small.md", "s");
    await a.sync();
    const b = new Device(remote, undefined, { maxFileSize: 1000 });
    await b.connect();
    await b.sync();
    expect(b.fs.paths()).toEqual(["small.md"]);
    b.fs.setText("small.md", "s2");
    await b.sync();
    await a.sync();
    expect(a.fs.paths()).toEqual(["big.bin", "small.md"]);
    expect(liveEntries(a).map(([, e]) => e.path).sort()).toEqual(["big.bin", "small.md"]);
  });

  it("ignored paths are not uploaded and the plugin folder never is", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText(".vaultsyncignore", "Temp/\n*.log\n");
    a.fs.setText("Temp/scratch.md", "scratch");
    a.fs.setText("debug.log", "log");
    a.fs.setText(".obsidian/plugins/encrypted-github-sync/data.json", "{}");
    a.fs.setText(".obsidian/app.json", "{}");
    a.fs.setText(".obsidian/workspace.json", "{}");
    a.fs.setText("keep.md", "k");
    await a.sync();
    await b.sync();
    expect(b.fs.paths()).toEqual([".obsidian/app.json", ".vaultsyncignore", "keep.md"]);
  });
});

describe("crash safety (§42, §53 failure injection)", () => {
  const points: CrashPoint[] = ["afterBlobUpload", "afterTreeCreation", "afterCommitCreation", "beforeRefUpdate", "afterRefUpdate"];
  for (const point of points) {
    it(`recovers from a crash ${point}`, async () => {
      const { a, b, remote } = await twoDevices();
      a.fs.setText("keep.md", "base");
      await a.sync();
      await b.sync();
      a.fs.setText("keep.md", "edited");
      a.fs.setText("new.md", "new file");
      remote.crashAt = point;
      await expect(a.sync()).rejects.toBeInstanceOf(CrashError);
      await a.restart();
      await a.sync();
      await b.sync();
      expect(a.fs.snapshot()).toEqual({ "keep.md": "edited", "new.md": "new file" });
      expect(b.fs.snapshot()).toEqual({ "keep.md": "edited", "new.md": "new file" });
      expect(liveEntries(a)).toHaveLength(2);
      expect(conflictFiles(a)).toEqual([]);
    });
  }

  it("recovers from a crash before the local state is persisted", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "one");
    await a.sync();
    a.fs.setText("n.md", "two");
    // Let the pending-commit save succeed, fail the save right after the ref update.
    const repo = a.repo;
    const original = repo.save.bind(repo);
    let saves = 0;
    repo.save = async (state) => {
      saves++;
      if (state.pendingCommit === null && saves > 1) throw new CrashError("beforeStatePersist");
      return original(state);
    };
    await expect(a.sync()).rejects.toBeInstanceOf(CrashError);
    repo.save = original;
    await a.restart();
    const report = await a.sync();
    expect(report.recoveredCommit).toBe(true);
    await b.sync();
    expect(b.fs.text("n.md")).toBe("two");
    expect(conflictFiles(a)).toEqual([]);
  });

  it("resumes an interrupted local apply from the journal", async () => {
    const { a, b, remote } = await twoDevices();
    for (let i = 0; i < 5; i++) a.fs.setText(`f${i}.md`, `v${i}`);
    await a.sync();
    let reads = 0;
    remote.onReadObject = () => {
      if (++reads === 3) {
        remote.onReadObject = null;
        throw new GitHubError("Network"); // connection lost in the middle of applying
      }
    };
    await expect(b.sync()).rejects.toBeInstanceOf(GitHubError);
    expect(b.store.state.journal).not.toBeNull();
    await b.restart();
    const report = await b.sync();
    expect(report.recoveredJournal).toBe(true);
    expect(Object.keys(b.fs.snapshot()).length).toBe(5);
    expect(conflictFiles(b)).toEqual([]);
    // Nothing left to push, nothing duplicated remotely.
    expect(liveEntries(b)).toHaveLength(5);
  });

  it("a failing local write keeps the old file and retries later", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.setText("n.md", "v2");
    await a.sync();
    b.fs.failWrite = () => true;
    const report = await b.sync();
    expect(report.failedLocalOps).toBe(1);
    expect(b.fs.text("n.md")).toBe("v1");
    b.fs.failWrite = null;
    await b.sync();
    expect(b.fs.text("n.md")).toBe("v2");
    // The failed apply must never have been pushed back as a "local" change.
    await a.sync();
    expect(a.fs.text("n.md")).toBe("v2");
  });

  it("lost local state never deletes anything", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    a.fs.setText("m.md", "m");
    await a.sync();
    await b.sync();
    b.fs.setText("n.md", "edited while state was lost");
    const fresh = new Device(b.remote, b.deviceId, {}, b.fs);
    await fresh.connect();
    await fresh.sync();
    expect(await fresh.fs.exists("m.md")).toBe(true);
    const texts = Object.values(fresh.fs.snapshot()).sort();
    expect(texts).toEqual(["edited while state was lost", "m", "v1"]);
  });
});

describe("repository manipulation (§43)", () => {
  it("deleted branch stops sync without touching the vault", async () => {
    const { a, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    remote.forceSetHead(null);
    await expectBlocked(a.sync(), "BranchDeleted");
    expect(a.fs.text("n.md")).toBe("v1");
  });

  it("force-push to an older commit is detected", async () => {
    const { a, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const old = remote.head as string;
    a.fs.setText("n.md", "v2");
    await a.sync();
    remote.forceSetHead(old);
    await expectBlocked(a.sync(), "HistoryRewritten");
    expect(a.fs.text("n.md")).toBe("v2");
  });

  it("corrupted or missing manifest stops sync", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const head = remote.commits.get(remote.head as string);
    const manifest = head?.files.get(MANIFEST_PATH) as Uint8Array;
    manifest[manifest.length - 3] = (manifest[manifest.length - 3] as number) ^ 1;
    await expectBlocked(b.sync(), "ManifestCorrupted");
    head?.files.delete(MANIFEST_PATH);
    await expectBlocked(b.sync(), "ManifestMissing");
    expect(b.fs.paths()).toEqual([]);
  });

  it("unknown format version is never modified", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const head = remote.commits.get(remote.head as string);
    const config = JSON.parse(new TextDecoder().decode(head?.files.get(CONFIG_PATH))) as Record<string, unknown>;
    head?.files.set(CONFIG_PATH, utf8Encode(JSON.stringify({ ...config, formatVersion: 2 })));
    await expectBlocked(b.sync(), "UnknownFormatVersion");
  });

  it("repository of a different vault is rejected", async () => {
    const { a, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const other = new FakeRemoteRepository();
    const intruder = new Device(other);
    await intruder.createVault();
    intruder.fs.setText("x.md", "x");
    await intruder.sync();
    // Replace the whole repository content with the other vault (same commit id space).
    const foreignHead = other.commits.get(other.head as string);
    const target = remote.commits.get(remote.head as string);
    target?.files.clear();
    for (const [p, d] of foreignHead?.files ?? []) target?.files.set(p, d);
    a.store.state.lastRemoteCommit = null;
    a.store.state.remote = null;
    await expectBlocked(a.sync(), "ForeignVault");
    expect(a.fs.text("n.md")).toBe("v1");
  });
});

describe("key management with remote (§26–§28)", () => {
  it("password change keeps data objects and other devices working", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const objectsBefore = remote.headFiles().filter((p) => p.startsWith("objects/"));
    await changeVaultPassword({ crypto, remote, store: a.store, keys: a.keys, deviceId: a.deviceId, newPassword: "the brand new password" });
    expect(remote.headFiles().filter((p) => p.startsWith("objects/"))).toEqual(objectsBefore);
    await b.sync(); // B keeps its unlocked master key
    expect(b.fs.text("n.md")).toBe("v1");
    await a.sync();

    const c = new Device(remote);
    await expect(c.connect({ password: PASSWORD })).rejects.toBeInstanceOf(CryptoError);
    await c.connect({ password: "the brand new password" });
    await c.sync();
    expect(c.fs.text("n.md")).toBe("v1");
  });

  it("recovery key connects a new device", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    const recoveryKey = await a.createVault();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const c = new Device(remote);
    await c.connect({ recoveryKey: recoveryKey as string });
    await c.sync();
    expect(c.fs.text("n.md")).toBe("v1");
  });
});

describe("performance target (§50)", () => {
  it("10,000 files: one changed note transfers and hashes one object", async () => {
    const { a, b, remote } = await twoDevices({ maxFilesPerCommit: 5000, maxCommitsPerRun: 10 });
    for (let i = 0; i < 10_000; i++) a.fs.setText(`notes/${i % 100}/${i}.md`, `note number ${i}`);
    await a.sync();
    await b.sync();
    a.fs.setText("notes/7/4207.md", "edited");
    const readsA = a.fs.readCount;
    const requestsBefore = remote.requestCount;
    const up = await a.sync();
    expect(up.uploaded).toBe(1);
    expect(a.fs.readCount - readsA).toBeLessThanOrEqual(3);
    const objectReads = remote.objectReads;
    const readsB = b.fs.readCount;
    const down = await b.sync();
    expect(down.downloaded).toBe(1);
    expect(remote.objectReads - objectReads).toBe(1);
    expect(b.fs.readCount - readsB).toBeLessThanOrEqual(5);
    expect(remote.requestCount - requestsBefore).toBeLessThan(20);
  }, 120_000);
});

describe("security fixes 0.3.1", () => {
  it("never re-signs a replayed manifest when the password changes (F1)", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    a.fs.setText("n.md", "v2");
    await a.sync();
    await b.sync();
    // Attacker without the key appends a commit that replays the previous tree (manifest v1 era).
    const head = remote.head!;
    const previous = remote.parentOf(head)!;
    const replay = "d".repeat(40);
    remote.commits.set(replay, { ...remote.commits.get(previous)!, sha: replay, parent: head, date: 0 });
    remote.forceSetHead(replay);
    const blocked = await a.sync().catch((e: unknown) => e);
    expect((blocked as SyncError).blockReason).toBe("HistoryRewritten");
    // The user reacts by changing the password: refused, nothing is published.
    const refused = await changeVaultPassword({ crypto, remote, store: a.store, keys: a.keys, deviceId: a.deviceId, newPassword: "another long password" }).catch((e: unknown) => e);
    expect((refused as SyncError).code).toBe("ConcurrentRemoteUpdate");
    expect(remote.head).toBe(replay);
    expect(b.fs.text("n.md")).toBe("v2");
  });

  it("records its own key update and binds the config to the manifest (K2)", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    const oldConfig = remote.commits.get(remote.head!)!.files.get(".vaultsync/config")!;
    await changeVaultPassword({ crypto, remote, store: a.store, keys: a.keys, deviceId: a.deviceId, newPassword: "the brand new password" });
    expect(a.store.state.lastRemoteCommit).toBe(remote.head);
    expect(a.store.state.remote!.configHash).toBeDefined();
    // Swapping the old (validly signed) config back into a sibling commit is detected.
    const head = remote.head!;
    const sibling = "c".repeat(40);
    const files = new Map(remote.commits.get(head)!.files);
    files.set(".vaultsync/config", oldConfig);
    remote.commits.set(sibling, { ...remote.commits.get(head)!, sha: sibling, files });
    remote.forceSetHead(sibling);
    const error = await b.sync().catch((e: unknown) => e);
    expect((error as SyncError).blockReason).toBe("ConfigCorrupted");
  });

  it("refuses an equal version and a sibling branch even if the server claims ancestry (F2)", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "base");
    await a.sync();
    await b.sync();
    const fork = remote.head!;
    // Two devices push on top of the same commit; the server lies that the losing branch descends from ours.
    b.fs.setText("n.md", "from b");
    await b.sync();
    b.fs.setText("n.md", "from b, again");
    await b.sync(); // b's branch is now ahead in version as well
    const bHead = remote.head!;
    remote.forceSetHead(fork);
    a.fs.setText("n.md", "from a");
    a.fs.setText("m.md", "only on a");
    await a.sync();
    remote.isAncestor = async () => true;
    remote.forceSetHead(bHead);
    const error = await a.sync().catch((e: unknown) => e);
    expect((error as SyncError).blockReason).toBe("HistoryRewritten");
    expect(a.fs.text("n.md")).toBe("from a");
    expect(a.fs.text("m.md")).toBe("only on a");
  });
});

describe("stale hash cache (L1)", () => {
  it("turns an unnoticed local edit into a conflict instead of diverging forever", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "aaaa");
    await a.sync();
    await b.sync();
    a.fs.setTextKeepingMtime("n.md", "bbbb"); // same size and mtime: the scan trusts the cached hash
    b.fs.setText("n.md", "cccc");
    await b.sync();
    const first = await a.sync();
    expect(first.failedLocalOps).toBe(1);
    expect(a.fs.text("n.md")).toBe("bbbb");
    const second = await a.sync();
    expect(second.newConflicts).toHaveLength(1);
    const contents = Object.values(a.fs.snapshot());
    expect(contents).toContain("bbbb");
    expect(contents).toContain("cccc");
    await b.sync();
    expect(Object.values(b.fs.snapshot())).toContain("bbbb");
  });
});

describe("key updates on an empty vault (review of 0.3.1)", () => {
  it("keeps other devices syncing after a password change on the bootstrap commit", async () => {
    const { a, b, remote } = await twoDevices();
    await a.sync();
    await b.sync();
    await changeVaultPassword({ crypto, remote, store: a.store, keys: a.keys, deviceId: a.deviceId, newPassword: "the brand new password" });
    await b.sync();
    a.fs.setText("first.md", "first note");
    await a.sync();
    await b.sync();
    expect(b.fs.text("first.md")).toBe("first note");
  });

  it("gives up early instead of walking the whole chain when a pending commit never landed", async () => {
    const { a, b, remote } = await twoDevices();
    for (let i = 0; i < 6; i++) {
      b.fs.setText("n.md", `b${i}`);
      await b.sync();
    }
    await a.sync();
    a.fs.setText("a.md", "lost race");
    remote.crashAt = "beforeRefUpdate";
    await a.sync().catch(() => undefined);
    b.fs.setText("n.md", "b wins");
    await b.sync();
    const reads = remote.requestCount;
    await a.sync();
    expect(a.store.state.pendingCommit).toBeNull();
    expect(remote.requestCount - reads).toBeLessThan(40);
    expect(a.fs.text("n.md")).toBe("b wins");
    await b.sync();
    expect(b.fs.text("a.md")).toBe("lost race");
  });
});
