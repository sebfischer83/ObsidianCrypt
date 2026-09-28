import { describe, expect, it } from "vitest";
import { SyncError } from "../src/errors/SyncError";
import { objectPath } from "../src/remote/RemoteLayout";
import { ActivityLog } from "../src/state/ActivityLog";
import type { BlobFileStore } from "../src/state/StateRepository";
import { ConflictResolver } from "../src/sync/ConflictResolver";
import { DeletedFiles } from "../src/sync/DeletedFiles";
import { RepositoryVerifier } from "../src/sync/RepositoryVerifier";
import { decodeText, diffLines, splitLines, type DiffLine } from "../src/util/diff";
import { utf8Decode, utf8Encode } from "../src/util/bytes";
import { crypto, Device, twoDevices } from "./fakes/harness";

function deletedFiles(d: Device): DeletedFiles {
  return new DeletedFiles({ crypto, fs: d.fs, remote: d.remote, store: d.store, getKeys: () => d.keys });
}

function verifier(d: Device, extra: { isCancelled?: () => boolean } = {}): RepositoryVerifier {
  return new RepositoryVerifier({ crypto, remote: d.remote, store: d.store, getKeys: () => d.keys, ...extra });
}

class MemoryBlobStore implements BlobFileStore {
  readonly files = new Map<string, Uint8Array>();
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data.slice());
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

describe("deleted files", () => {
  it("lists files deleted on another device and restores them without overwriting anything", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Notes/Old.md", "first");
    a.fs.setText("Keep.md", "keep");
    await a.sync();
    await a.fs.rename("Notes/Old.md", "Notes/Renamed.md");
    a.store.recordRename("Notes/Old.md", "Notes/Renamed.md");
    a.fs.setText("Notes/Renamed.md", "last version");
    await a.sync();
    await b.sync();
    await b.fs.trash("Notes/Renamed.md");
    await b.sync();
    await a.sync();
    expect(await a.fs.exists("Notes/Renamed.md")).toBe(false);

    const deleted = deletedFiles(a);
    const [file] = deleted.list();
    expect(deleted.list()).toHaveLength(1);
    const resolved = (await deleted.resolve(file!))!;
    expect(resolved).toMatchObject({ path: "Notes/Renamed.md", size: "last version".length, deletedBy: b.deviceId });
    const content = await deleted.load(resolved);
    expect(utf8Decode(content)).toBe("last version");

    expect(await deleted.restore(resolved, content)).toBe("Notes/Renamed.md");
    expect(await deleted.restore(resolved, content)).toBe("Notes/Renamed (restored).md");
    await a.sync();
    await b.sync();
    expect(b.fs.text("Notes/Renamed.md")).toBe("last version");
    expect(b.fs.text("Keep.md")).toBe("keep");
  });

  it("restores chunked files and several files deleted in one commit", async () => {
    const { a } = await twoDevices({ chunkSize: 8 });
    a.fs.setText("Dir/big.txt", "0123456789".repeat(5));
    a.fs.setText("Dir/small.txt", "small");
    await a.sync();
    await a.fs.trash("Dir/big.txt");
    await a.fs.trash("Dir/small.txt");
    await a.sync();
    const deleted = deletedFiles(a);
    const restored: Record<string, string> = {};
    for (const file of deleted.list()) {
      const resolved = (await deleted.resolve(file))!;
      restored[resolved.path] = utf8Decode(await deleted.load(resolved));
    }
    expect(restored).toEqual({ "Dir/big.txt": "0123456789".repeat(5), "Dir/small.txt": "small" });
  });
});

describe("repository verification", () => {
  it("verifies every file of a healthy repository", async () => {
    const { a } = await twoDevices({ chunkSize: 8 });
    a.fs.setText("a.md", "alpha");
    a.fs.setText("big.bin", "x".repeat(30));
    await a.sync();
    const progress: number[] = [];
    const report = await new RepositoryVerifier({ crypto, remote: a.remote, store: a.store, getKeys: () => a.keys, onProgress: (done) => progress.push(done) }).verify();
    expect(report).toMatchObject({ files: 2, verified: 2, problems: [], orphans: 0, treeComplete: true, stopped: null, totalBytes: 35 });
    expect(progress.at(-1)).toBe(2);
  });

  it("reports corrupted and missing objects and orphans by path", async () => {
    const { remote, a } = await twoDevices();
    a.fs.setText("ok.md", "fine");
    a.fs.setText("broken.md", "will be corrupted");
    a.fs.setText("gone.md", "will vanish");
    await a.sync();
    const files = remote.commits.get(remote.head!)!.files;
    const id = (path: string): string => a.store.state.localMap[path]!;
    const broken = files.get(objectPath(id("broken.md")))!.slice();
    broken[broken.length - 1]! ^= 1;
    files.set(objectPath(id("broken.md")), broken);
    files.delete(objectPath(id("gone.md")));
    files.set(objectPath("f".repeat(32)), files.get(objectPath(id("ok.md")))!);

    const report = await verifier(a).verify();
    expect(report.verified).toBe(1);
    expect(report.problems).toEqual([
      { path: "broken.md", problem: "corrupted" },
      { path: "gone.md", problem: "missing" },
    ]);
    expect(report.orphans).toBe(1);
  });

  it("stops when cancelled and refuses a manifest detached from its history", async () => {
    const { remote, a } = await twoDevices();
    a.fs.setText("a.md", "a");
    a.fs.setText("b.md", "b");
    await a.sync();
    const report = await verifier(a, { isCancelled: () => true }).verify();
    expect(report.stopped).toBe("Cancelled.");
    expect(report.verified).toBe(0);

    const head = remote.head!;
    const forged = "e".repeat(40);
    remote.commits.set(forged, { ...remote.commits.get(head)!, sha: forged, parent: head });
    remote.forceSetHead(forged);
    const error = await verifier(a).verify().catch((e: unknown) => e);
    expect((error as SyncError).blockReason).toBe("HistoryRewritten");
  });
});

describe("activity", () => {
  it("reports every file change of a sync", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("new.md", "n");
    a.fs.setText("move.md", "m");
    a.fs.setText("del.md", "d");
    const first = await a.sync();
    expect(first.changes.map((c) => `${c.action}:${c.path}`).sort()).toEqual(["uploaded:del.md", "uploaded:move.md", "uploaded:new.md"]);

    expect((await b.sync()).changes.map((c) => c.action)).toEqual(["downloaded", "downloaded", "downloaded"]);
    await b.fs.rename("move.md", "moved.md");
    b.store.recordRename("move.md", "moved.md");
    await b.fs.trash("del.md");
    b.fs.setText("new.md", "changed");
    const pushed = await b.sync();
    expect(pushed.changes).toEqual(
      expect.arrayContaining([
        { action: "uploaded", path: "new.md" },
        { action: "deletedRemotely", path: "del.md" },
        { action: "movedRemotely", path: "moved.md", other: "move.md" },
      ]),
    );

    const pulled = await a.sync();
    expect(pulled.changes).toEqual(
      expect.arrayContaining([
        { action: "downloaded", path: "new.md" },
        { action: "deletedLocally", path: "del.md" },
        { action: "movedLocally", path: "moved.md", other: "move.md" },
      ]),
    );
  });

  it("keeps a bounded log that survives reloads and ignores damaged data", async () => {
    const store = new MemoryBlobStore();
    const log = new ActivityLog(store, "activity.json", 3, 2);
    await log.load();
    for (let i = 0; i < 5; i++) await log.add("sync", `sync ${i}`, [{ action: "uploaded", path: "a" }, { action: "uploaded", path: "b" }, { action: "uploaded", path: "c" }], i);
    const reloaded = new ActivityLog(store, "activity.json", 3, 2);
    await reloaded.load();
    expect(reloaded.entries.map((e) => e.summary)).toEqual(["sync 4", "sync 3", "sync 2"]);
    expect(reloaded.entries[0]).toMatchObject({ omitted: 1, changes: [{ path: "a" }, { path: "b" }] });

    store.files.set("activity.json", utf8Encode("{broken"));
    await reloaded.load();
    expect(reloaded.entries).toEqual([]);
  });
});

describe("conflict resolution", () => {
  async function contentConflict() {
    const { a, b } = await twoDevices();
    a.fs.setText("Note.md", "base");
    await a.sync();
    await b.sync();
    a.fs.setText("Note.md", "from A");
    b.fs.setText("Note.md", "from B");
    await a.sync();
    await b.sync();
    const [conflict] = b.store.state.conflicts;
    const resolver = new ConflictResolver({ crypto, fs: b.fs, store: b.store });
    return { a, b, conflict: conflict!, resolver };
  }

  it("keeps the synced version and moves the copy to the trash", async () => {
    const { b, conflict, resolver } = await contentConflict();
    const sides = await resolver.load(conflict);
    expect(utf8Decode(sides.synced!)).toBe("from A");
    expect(utf8Decode(sides.copy!)).toBe("from B");
    await resolver.keepSynced(conflict, await crypto.hash(sides.copy!));
    expect(await b.fs.exists(conflict.conflictPath!)).toBe(false);
    expect(b.fs.trashed.map((t) => utf8Decode(t.data))).toContain("from B");
    expect(b.store.state.conflicts).toEqual([]);
  });

  it("keeps the copy by replacing the synced version, which then syncs everywhere", async () => {
    const { a, b, conflict, resolver } = await contentConflict();
    const sides = await resolver.load(conflict);
    expect(await resolver.canReplaceSynced(conflict)).toBe(true);
    await resolver.keepCopy(conflict, await crypto.hash(sides.copy!));
    expect(b.fs.text("Note.md")).toBe("from B");
    expect(await b.fs.exists(conflict.conflictPath!)).toBe(false);
    await b.sync();
    await a.sync();
    expect(a.fs.text("Note.md")).toBe("from B");
    expect(await a.fs.exists(conflict.conflictPath!)).toBe(false);
  });

  it("refuses when a file changed after comparing or the synced version has unsynced edits", async () => {
    const { b, conflict, resolver } = await contentConflict();
    const sides = await resolver.load(conflict);
    const hash = await crypto.hash(sides.copy!);
    b.fs.setText(conflict.conflictPath!, "edited copy");
    await expect(resolver.keepSynced(conflict, hash)).rejects.toBeInstanceOf(SyncError);
    await expect(resolver.keepCopy(conflict, hash)).rejects.toBeInstanceOf(SyncError);
    expect(b.fs.text(conflict.conflictPath!)).toBe("edited copy");

    b.fs.setText("Note.md", "unsynced edit");
    const error = await resolver.keepCopy(conflict, await crypto.hash(utf8Encode("edited copy"))).catch((e: unknown) => e);
    expect((error as SyncError).code).toBe("UnsyncedChanges");
    expect(b.fs.text("Note.md")).toBe("unsynced edit");
    expect(b.store.state.conflicts).toHaveLength(1);
  });
});

describe("line diff", () => {
  const apply = (lines: DiffLine[], side: "a" | "b"): string[] => lines.filter((l) => l.type === "equal" || l.type === (side === "a" ? "removed" : "added")).map((l) => l.text);

  it("finds a minimal diff", () => {
    const diff = diffLines(splitLines("a\nb\nc\nd\n"), splitLines("a\r\nx\r\nc\r\nd\r\ne"))!;
    expect(diff).toEqual([
      { type: "equal", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "x" },
      { type: "equal", text: "c" },
      { type: "equal", text: "d" },
      { type: "added", text: "e" },
    ]);
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines(["a"], [])).toEqual([{ type: "removed", text: "a" }]);
  });

  it("reconstructs both sides for random inputs and gives up on huge differences", () => {
    let seed = 42;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => String.fromCharCode(97 + Math.floor(rnd() * 4)));
      const b = Array.from({ length: Math.floor(rnd() * 30) }, () => String.fromCharCode(97 + Math.floor(rnd() * 4)));
      const diff = diffLines(a, b)!;
      expect(apply(diff, "a")).toEqual(a);
      expect(apply(diff, "b")).toEqual(b);
    }
    const big = Array.from({ length: 200 }, (_, i) => `a${i}`);
    const other = Array.from({ length: 200 }, (_, i) => `b${i}`);
    expect(diffLines(big, other, 50)).toBeNull();
  });

  it("detects binary content", () => {
    expect(decodeText(utf8Encode("Grüße"))).toBe("Grüße");
    expect(decodeText(new Uint8Array([0x66, 0, 0x67]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
