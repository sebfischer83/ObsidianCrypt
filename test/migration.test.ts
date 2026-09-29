import { describe, expect, it } from "vitest";
import { SyncError } from "../src/errors/SyncError";
import { isLive } from "../src/manifest/Manifest";
import type { BackendLocation } from "../src/remote/BackendLocation";
import { CONFIG_PATH } from "../src/remote/RemoteLayout";
import { DeletedFiles } from "../src/sync/DeletedFiles";
import { readVerifiedHead } from "../src/sync/HistoryReader";
import { followMove, moveVault, type MoveOptions } from "../src/sync/VaultMigration";
import { VersionHistory } from "../src/sync/VersionHistory";
import { utf8Decode } from "../src/util/bytes";
import { CrashError, FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { crypto, Device, twoDevices } from "./fakes/harness";
import { findLeaks } from "./security.test";

const OLD: BackendLocation = { kind: "github", owner: "alice", repo: "vault", branch: "main" };
const NEW: BackendLocation = { kind: "github", owner: "alice", repo: "vault-2", branch: "main" };

function move(d: Device, target: FakeRemoteRepository, extra: Partial<MoveOptions> = {}) {
  return moveVault({ crypto, keys: d.keys, store: d.store, deviceId: d.deviceId, source: d.remote, sourceLocation: OLD, target, targetLocation: NEW, ...extra });
}

async function blockedReason(p: Promise<unknown>): Promise<string | null> {
  const error = await p.catch((e: unknown) => e);
  return error instanceof SyncError ? (error.blockReason ?? error.code) : null;
}

describe("moving a vault to a new repository", () => {
  it("copies the current state, retires the old repository and lets other devices follow", async () => {
    const { remote: old, a, b } = await twoDevices({ chunkSize: 8 });
    a.fs.setText("Note.md", "v1");
    a.fs.setText("Big.bin", "0123456789".repeat(4));
    a.fs.setText("Gone.md", "deleted before the move");
    await a.sync();
    await a.fs.trash("Gone.md");
    await a.sync();
    await b.sync();

    const before = a.store.state.remote!.entries;
    const oldFiles = old.headFiles();
    const target = new FakeRemoteRepository();
    const result = await move(a, target);
    expect(result.copied).toBe(2);

    // New repository: same ids, paths and contents, tombstones kept, archive linked.
    const head = await readVerifiedHead(target, crypto, a.keys, a.deviceId);
    const summary = (entries: typeof before) =>
      Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, isLive(e) ? `${e.path}:${e.contentHash}:${e.size}` : "deleted"]));
    expect(summary(head.manifest.entries)).toEqual(summary(before));
    expect(Object.values(summary(before))).toContain("deleted");
    expect(head.manifest.movedFrom).toEqual([{ ...OLD, commit: old.parentOf(old.head!) }]);
    expect(findLeaks(target.everythingStored(), ["Note.md", "first version of the note", "0123456789", "Gone.md", "deleted before"])).toEqual([]);

    // Old repository: only the manifest (marker) changed; nothing was deleted.
    expect(old.headFiles()).toEqual(oldFiles);
    expect(await blockedReason(b.sync())).toBe("VaultMoved");
    expect(b.store.state.movedTo).toMatchObject(NEW);

    a.switchRemote(target);
    expect((await a.sync()).changes).toEqual([]);
    a.fs.setText("Note.md", "v2 after move");
    await a.sync();

    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: OLD, target });
    b.switchRemote(target);
    const report = await b.sync();
    expect(report.newConflicts).toEqual([]);
    expect(b.fs.text("Note.md")).toBe("v2 after move");
    expect(b.fs.snapshot()).toEqual(a.fs.snapshot());
    expect(await a.engine.countPendingChanges()).toBe(0);
  });

  it("keeps unsynced changes of a following device without conflicts", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("a.md", "a");
    a.fs.setText("b.md", "b");
    await a.sync();
    await b.sync();
    b.fs.setText("b.md", "b edited offline");
    b.fs.setText("new.md", "created offline");

    const target = new FakeRemoteRepository();
    await move(a, target);
    a.switchRemote(target);

    expect(await blockedReason(b.sync())).toBe("VaultMoved");
    expect(b.fs.text("b.md")).toBe("b edited offline");
    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: OLD, target });
    b.switchRemote(target);
    expect((await b.sync()).newConflicts).toEqual([]);
    await a.sync();
    expect(a.fs.text("b.md")).toBe("b edited offline");
    expect(a.fs.text("new.md")).toBe("created offline");
  });

  it("keeps version history and deleted files reachable through the archive", async () => {
    const { remote: old, a } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    a.fs.setText("Old.md", "deleted long ago");
    await a.sync();
    a.fs.setText("Note.md", "v2");
    await a.fs.trash("Old.md");
    await a.sync();
    const target = new FakeRemoteRepository();
    await move(a, target);
    a.switchRemote(target);
    a.fs.setText("Note.md", "v3");
    await a.sync();

    const archives = (a.store.state.remote!.movedFrom ?? []).map((r) => ({ remote: old, from: r.commit }));
    expect(archives).toHaveLength(1);
    const history = new VersionHistory({ crypto, fs: a.fs, remote: target, store: a.store, getKeys: () => a.keys, archives });
    const versions = await history.list("Note.md", 10);
    const texts: string[] = [];
    for (const v of versions) texts.push(utf8Decode((await history.load(v))!));
    expect(texts).toEqual(["v3", "v2", "v1"]);
    expect(versions.map((v) => v.source)).toEqual([0, 1, 1]);

    const deleted = new DeletedFiles({ crypto, fs: a.fs, remote: target, store: a.store, getKeys: () => a.keys, archives });
    const [file] = deleted.list();
    const resolved = (await deleted.resolve(file!))!;
    expect(resolved).toMatchObject({ path: "Old.md", source: 1 });
    expect(utf8Decode(await deleted.load(resolved))).toBe("deleted long ago");
  });

  it("resumes an interrupted copy and repeats after a concurrent push", async () => {
    const { remote: old, a, b } = await twoDevices();
    for (let i = 0; i < 5; i++) a.fs.setText(`n${i}.md`, `note ${i}`);
    await a.sync();
    await b.sync();

    const target = new FakeRemoteRepository();
    const updateHead = target.updateHead.bind(target);
    let refUpdates = 0;
    target.updateHead = async (expected, commit) => {
      await updateHead(expected, commit);
      if (++refUpdates === 2) throw new CrashError("afterRefUpdate");
    };
    await expect(move(a, target, { limits: { maxFilesPerCommit: 2 } })).rejects.toBeInstanceOf(CrashError);
    target.updateHead = updateHead;

    // Another device pushes before the marker is written: the marker CAS fails, nothing is lost.
    old.beforeUpdateHead = async () => {
      b.fs.setText("n0.md", "changed by b during the move");
      await b.sync();
    };
    expect(await blockedReason(move(a, target, { limits: { maxFilesPerCommit: 2 } }))).toBe("ConcurrentRemoteUpdate");
    await a.sync();
    const second = await move(a, target, { limits: { maxFilesPerCommit: 2 } });
    expect(second.copied).toBe(1);

    a.switchRemote(target);
    await a.sync();
    expect(a.fs.text("n0.md")).toBe("changed by b during the move");
    const head = await readVerifiedHead(target, crypto, a.keys, a.deviceId);
    expect(Object.values(head.manifest.entries).filter(isLive)).toHaveLength(5);
    expect(target.headFiles().filter((p) => p.startsWith("objects/"))).toHaveLength(5);
  });


  it("finishes a switch interrupted before the settings changed", async () => {
    const { remote: old, a } = await twoDevices();
    a.fs.setText("n.md", "before");
    await a.sync();
    const target = new FakeRemoteRepository();
    await move(a, target);
    // The app stops before settings and state are switched: after a restart the switch is still recorded.
    await a.restart();
    expect(a.store.state.pendingSwitch).toMatchObject({ location: NEW });
    // Nothing is synchronised in between – neither with the old nor the new repository.
    expect(await blockedReason(a.sync())).toBe("InvalidState");
    expect(old.head).not.toBeNull();
    a.fs.setText("n.md", "edited after restart");
    a.switchRemote(target);
    await a.sync();
    const b = new Device(target);
    await b.connect();
    await b.sync();
    expect(b.fs.text("n.md")).toBe("edited after restart");
  });

  it("follows a chain of moves instead of writing into an archive (F3)", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    const second = new FakeRemoteRepository();
    const third = new FakeRemoteRepository();
    const SECOND = NEW;
    const THIRD: BackendLocation = { kind: "github", owner: "alice", repo: "vault-3", branch: "main" };
    await move(a, second);
    a.switchRemote(second);
    await moveVault({ crypto, keys: a.keys, store: a.store, deviceId: a.deviceId, source: second, sourceLocation: SECOND, target: third, targetLocation: THIRD });
    a.switchRemote(third);

    // b is still on the first repository and follows one hop: the second one announces the next move.
    expect(await blockedReason(b.sync())).toBe("VaultMoved");
    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: OLD, target: second });
    b.switchRemote(second);
    expect(b.store.state.movedTo).toMatchObject(THIRD);
    b.fs.setText("n.md", "edited by b");
    expect(await blockedReason(b.sync())).toBe("VaultMoved");
    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: SECOND, target: third });
    b.switchRemote(third);
    await b.sync();
    await a.sync();
    expect(a.fs.text("n.md")).toBe("edited by b");
  });

  it("refuses unsafe targets and states", async () => {
    const { a } = await twoDevices();
    a.fs.setText("x.md", "x");
    await a.sync();

    const foreign = new FakeRemoteRepository();
    const c = await foreign.initialize({ ...(await readVerifiedHead(a.remote, crypto, a.keys, a.deviceId)).config }, { message: "x" });
    foreign.commits.get(c)!.files.set("README.md", new TextEncoder().encode("hello"));
    foreign.commits.get(c)!.files.delete(CONFIG_PATH);
    expect(await blockedReason(move(a, foreign))).toBe("RepositoryNotEmpty");

    const other = await twoDevices();
    expect(await blockedReason(move(a, other.remote))).toBe("ForeignVault");

    const stale = new Device(a.remote);
    await stale.connect();
    stale.fs.setText("y.md", "y");
    await stale.sync();
    expect(await blockedReason(move(a, new FakeRemoteRepository()))).toBe("InvalidState");

    // A device can only follow to a repository that names the old one as its predecessor.
    await a.sync();
    const target = new FakeRemoteRepository();
    await move(a, target);
    expect(await blockedReason(stale.sync())).toBe("VaultMoved");
    expect(await blockedReason(followMove({ crypto, keys: stale.keys, store: stale.store, deviceId: stale.deviceId, sourceLocation: OLD, target: other.remote }))).toBe("ForeignVault");
    const unrelated = new FakeRemoteRepository();
    await unrelated.initialize((await readVerifiedHead(target, crypto, a.keys, a.deviceId)).config, { message: "x" });
    expect(await blockedReason(followMove({ crypto, keys: stale.keys, store: stale.store, deviceId: stale.deviceId, sourceLocation: OLD, target: unrelated }))).toBe("InvalidState");
  });
});

describe("moving a vault over the GitHub API", () => {
  function github(server: FakeGitHubServer) {
    const client = new GitHubClient({ http: server, auth: new PersonalAccessTokenAuth(() => server.token), sleep: async () => undefined, minWriteIntervalMs: 0 });
    const api = new GitObjectsApi(client, server.owner, server.repo);
    return { api, remote: new GitHubRemoteRepository(api, { branch: "main" }) };
  }

  it("creates the private target repository, moves, reports sizes and follows", async () => {
    const oldServer = new FakeGitHubServer("alice", "vault");
    const newServer = new FakeGitHubServer("alice", "vault-2");
    newServer.repoExists = false;
    const oldGh = github(oldServer);
    const newGh = github(newServer);
    const a = new Device(oldGh.remote, undefined, { chunkSize: 1024 });
    await a.createVault();
    const b = new Device(oldGh.remote, undefined, { chunkSize: 1024 });
    await b.connect();
    a.fs.setText("Geheim.md", "vertraulicher Inhalt");
    a.fs.setText("Gross.bin", "x".repeat(5000));
    await a.sync();
    await b.sync();
    expect((await oldGh.api.getRepository()).sizeBytes).toBeGreaterThan(0);

    expect((await newGh.api.getRepository()).exists).toBe(false);
    await newGh.api.createPrivateRepository();
    expect((await newGh.api.getRepository()).exists).toBe(true);
    await moveVault({ crypto, keys: a.keys, store: a.store, deviceId: a.deviceId, source: oldGh.remote, sourceLocation: OLD, target: newGh.remote, targetLocation: NEW });
    a.switchRemote(newGh.remote);
    a.fs.setText("Geheim.md", "nach dem Umzug");
    await a.sync();

    expect(await blockedReason(b.sync())).toBe("VaultMoved");
    await followMove({ crypto, keys: b.keys, store: b.store, deviceId: b.deviceId, sourceLocation: OLD, target: newGh.remote });
    b.switchRemote(newGh.remote);
    await b.sync();
    expect(b.fs.text("Geheim.md")).toBe("nach dem Umzug");
    expect(b.fs.text("Gross.bin")).toBe("x".repeat(5000));
    expect(findLeaks([...oldServer.everything(), ...newServer.everything()], ["Geheim", "vertraulicher Inhalt", "nach dem Umzug", "Gross"])).toEqual([]);
  });

  it("reports a missing permission to create repositories", async () => {
    const server = new FakeGitHubServer("alice", "vault-2");
    server.repoExists = false;
    server.canCreateRepos = false;
    await expect(github(server).api.createPrivateRepository()).rejects.toThrow();
  });
});
