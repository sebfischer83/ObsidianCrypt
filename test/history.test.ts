import { describe, expect, it } from "vitest";
import { CryptoError } from "../src/errors/CryptoError";
import { SyncError } from "../src/errors/SyncError";
import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { objectPath } from "../src/remote/RemoteLayout";
import { versionCopyPath } from "../src/sync/ConflictNaming";
import { VersionHistory, type FileVersion } from "../src/sync/VersionHistory";
import { utf8Decode } from "../src/util/bytes";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { crypto, Device, twoDevices } from "./fakes/harness";
import { findLeaks } from "./security.test";

function historyOf(device: Device): VersionHistory {
  return new VersionHistory({ crypto, fs: device.fs, remote: device.remote, store: device.store, getKeys: () => device.keys });
}

async function contents(history: VersionHistory, versions: FileVersion[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const v of versions) {
    const data = await history.load(v);
    out.push(data ? utf8Decode(data) : null);
  }
  return out;
}

describe("version history", () => {
  it("lists versions from all devices newest first and decrypts each of them", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    await a.sync();
    await b.sync();
    b.fs.setText("Note.md", "v2");
    await b.sync();
    await a.sync();
    a.fs.setText("Note.md", "v3");
    a.fs.setText("Other.md", "unrelated");
    await a.sync();

    const history = historyOf(a);
    const versions = await history.list("Note.md", 20);
    expect(await contents(history, versions)).toEqual(["v3", "v2", "v1"]);
    expect(versions.map((v) => v.device)).toEqual([a.deviceId, b.deviceId, a.deviceId]);
    expect(versions[0]!.date).toBeGreaterThan(versions[1]!.date);
  });

  it("respects the configured limit", async () => {
    const { a } = await twoDevices();
    for (let i = 1; i <= 5; i++) {
      a.fs.setText("Note.md", `v${i}`);
      await a.sync();
    }
    const history = historyOf(a);
    expect(await contents(history, await history.list("Note.md", 2))).toEqual(["v5", "v4"]);
  });

  it("keeps the history across renames and has none for unsynchronised files", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Old.md", "v1");
    await a.sync();
    a.fs.setText("Old.md", "v2");
    await a.sync();
    await a.fs.rename("Old.md", "New.md");
    a.store.recordRename("Old.md", "New.md");
    await a.sync();
    a.fs.setText("Fresh.md", "not synced");

    const history = historyOf(a);
    expect(await contents(history, await history.list("New.md", 20))).toEqual(["v2", "v1"]);
    expect(await history.list("new.md", 20)).toHaveLength(2);
    expect(await history.list("Fresh.md", 20)).toEqual([]);
  });

  it("restores an older version, which the next sync uploads as a new version", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Note.md", "original");
    await a.sync();
    a.fs.setText("Note.md", "bad edit");
    await a.sync();
    await b.sync();

    const history = historyOf(a);
    const versions = await history.list("Note.md", 20);
    const old = versions[1]!;
    expect(await history.restore("Note.md", old, (await history.load(old))!)).toBe("restored");
    expect(a.fs.text("Note.md")).toBe("original");

    await a.sync();
    await b.sync();
    expect(b.fs.text("Note.md")).toBe("original");
    // Nothing was lost: the replaced content is still a version.
    expect(await contents(history, await history.list("Note.md", 20))).toEqual(["original", "bad edit", "original"]);
  });

  it("refuses to replace content that is not in the remote history yet", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    await a.sync();
    a.fs.setText("Note.md", "v2");
    await a.sync();
    a.fs.setText("Note.md", "unsynced work");

    const history = historyOf(a);
    const old = (await history.list("Note.md", 20))[1]!;
    expect(await history.isCurrentContentSynced("Note.md", old.objectId)).toBe(false);
    const error = await history.restore("Note.md", old, (await history.load(old))!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("UnsyncedChanges");
    expect(a.fs.text("Note.md")).toBe("unsynced work");

    await a.sync();
    expect(await history.isCurrentContentSynced("Note.md", old.objectId)).toBe(true);
    expect(await history.restore("Note.md", old, (await history.load(old))!)).toBe("restored");
    expect(a.fs.text("Note.md")).toBe("v1");
  });

  it("does nothing when the version equals the current content", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Note.md", "same");
    await a.sync();
    const history = historyOf(a);
    const [current] = await history.list("Note.md", 20);
    const writes = a.fs.writeCount;
    expect(await history.restore("Note.md", current!, (await history.load(current!))!)).toBe("unchanged");
    expect(a.fs.writeCount).toBe(writes);
  });

  it("refuses to restore into a different file that took over the path", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    await a.sync();
    const history = historyOf(a);
    const [version] = await history.list("Note.md", 20);
    const content = (await history.load(version!))!;
    const error = await history.restore("Note.md", { ...version!, objectId: "0".repeat(32) }, content).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(a.fs.text("Note.md")).toBe("v1");
  });

  it("restores a version as a copy without touching the original, even with unsynced changes", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Folder/Note.md", "v1");
    await a.sync();
    a.fs.setText("Folder/Note.md", "unsynced work");
    const history = historyOf(a);
    const [version] = await history.list("Folder/Note.md", 20);
    const content = (await history.load(version!))!;

    const first = await history.restoreAsCopy("Folder/Note.md", version!, content);
    const second = await history.restoreAsCopy("Folder/Note.md", version!, content);
    expect(first).toBe(versionCopyPath("Folder/Note.md", version!.date));
    expect(first).toMatch(/^Folder\/Note \(version \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    expect(second).toBe(versionCopyPath("Folder/Note.md", version!.date, 2));
    expect(a.fs.text(first)).toBe("v1");
    expect(a.fs.text(second)).toBe("v1");
    expect(a.fs.text("Folder/Note.md")).toBe("unsynced work");
  });

  it("returns null for a commit that removed the file", async () => {
    const { a } = await twoDevices();
    a.fs.setText("Note.md", "v1");
    await a.sync();
    const history = historyOf(a);
    const objectId = history.objectIdFor("Note.md")!;
    await a.fs.trash("Note.md");
    await a.sync();
    const revisions = await a.remote.listObjectRevisions(a.store.state.lastRemoteCommit!, objectId, 20);
    expect(revisions).toHaveLength(2);
    expect(await history.load({ ...revisions[0]!, objectId })).toBeNull();
    expect(utf8Decode((await history.load({ ...revisions[1]!, objectId }))!)).toBe("v1");
  });

  it("rejects a foreign object planted at the file's remote path", async () => {
    const { remote, a } = await twoDevices();
    a.fs.setText("Note.md", "mine");
    a.fs.setText("Secret.md", "other file");
    await a.sync();
    const history = historyOf(a);
    const [version] = await history.list("Note.md", 20);
    const files = remote.commits.get(version!.commit)!.files;
    files.set(objectPath(version!.objectId), files.get(objectPath(history.objectIdFor("Secret.md")!))!);
    await expect(history.load(version!)).rejects.toBeInstanceOf(CryptoError);
  });

  it("works against the GitHub API without sending plaintext", async () => {
    const server = new FakeGitHubServer();
    const client = new GitHubClient({ http: server, auth: new PersonalAccessTokenAuth(() => server.token), sleep: async () => undefined, minWriteIntervalMs: 0 });
    const remote = new GitHubRemoteRepository(new GitObjectsApi(client, server.owner, server.repo), { branch: "main" });
    const a = new Device(remote);
    await a.createVault();
    const b = new Device(remote);
    await b.connect();
    a.fs.setText("Tagebuch.md", "Erster Eintrag geheim");
    await a.sync();
    await b.sync();
    b.fs.setText("Tagebuch.md", "Zweiter Eintrag geheim");
    await b.sync();
    await a.sync();

    const history = historyOf(a);
    const versions = await history.list("Tagebuch.md", 20);
    expect(await contents(history, versions)).toEqual(["Zweiter Eintrag geheim", "Erster Eintrag geheim"]);
    expect(versions.map((v) => v.device)).toEqual([b.deviceId, a.deviceId]);
    await history.restore("Tagebuch.md", versions[1]!, (await history.load(versions[1]!))!);
    await a.sync();
    await b.sync();
    expect(b.fs.text("Tagebuch.md")).toBe("Erster Eintrag geheim");

    const listing = server.requests.filter((r) => r.url.includes("/commits?"));
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.every((r) => /\/commits\?sha=[0-9a-f]{40}&path=objects%2F[0-9a-f]{2}%2F[0-9a-f]{32}&per_page=20$/.test(r.url))).toBe(true);
    expect(findLeaks(server.everything(), ["Tagebuch", "Erster Eintrag geheim", "Zweiter Eintrag geheim"])).toEqual([]);
  });
});
