import { describe, expect, it } from "vitest";
import { EncryptionEngine } from "../src/crypto/EncryptionEngine";
import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { isLive, MANIFEST_FORMAT_VERSION } from "../src/manifest/Manifest";
import { objectPath } from "../src/remote/RemoteLayout";
import { decodeChunkIndex, encodeChunkIndex, readChunkIndex } from "../src/sync/ChunkedContent";
import { VersionHistory } from "../src/sync/VersionHistory";
import { utf8Decode } from "../src/util/bytes";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { crypto, Device, twoDevices } from "./fakes/harness";
import { findLeaks } from "./security.test";

const CHUNK = 16;

function objectFiles(files: string[]): string[] {
  return files.filter((p) => p.startsWith("objects/"));
}

function entryOf(device: Device, path: string) {
  const id = device.store.state.localMap[path]!;
  return { id, entry: device.store.state.remote!.entries[id]! };
}

async function chunksOf(device: Device, path: string) {
  const { id } = entryOf(device, path);
  return readChunkIndex(device.remote, new EncryptionEngine(crypto, device.keys), device.store.state.lastRemoteCommit!, id);
}

describe("large files (chunked objects)", () => {
  it("round-trips a chunked file and writes manifest format 2", async () => {
    const { remote, a, b } = await twoDevices({ chunkSize: CHUNK });
    const text = "0123456789abcdef".repeat(4) + "tail";
    a.fs.setText("Big.md", text);
    a.fs.setText("Small.md", "tiny");
    await a.sync();
    await b.sync();
    expect(b.fs.text("Big.md")).toBe(text);
    expect(b.fs.text("Small.md")).toBe("tiny");

    const { entry } = entryOf(a, "Big.md");
    expect(entry).toMatchObject({ chunks: 5 });
    expect(a.store.state.remote!.formatVersion).toBe(MANIFEST_FORMAT_VERSION);
    expect(isLive(entryOf(a, "Small.md").entry) && "chunks" in entryOf(a, "Small.md").entry).toBe(false);
    // index + 5 chunks + small file
    expect(objectFiles(remote.headFiles())).toHaveLength(7);
  });

  it("uploads only changed chunks and removes obsolete ones from the tree", async () => {
    const { remote, a, b } = await twoDevices({ chunkSize: CHUNK });
    const base = "A".repeat(16) + "B".repeat(16) + "C".repeat(16) + "D".repeat(16);
    a.fs.setText("Big.bin", base);
    await a.sync();
    await b.sync();
    const before = await chunksOf(a, "Big.bin");

    const uploadsBefore = remote.uploads.size;
    a.fs.setText("Big.bin", "A".repeat(16) + "B".repeat(16) + "X".repeat(16) + "D".repeat(16) + "E");
    await a.sync();
    expect(remote.uploads.size - uploadsBefore).toBe(2);
    const after = await chunksOf(a, "Big.bin");
    expect(after.map((c) => c.id).slice(0, 2)).toEqual(before.map((c) => c.id).slice(0, 2));
    expect(after[3]!.id).toBe(before[3]!.id);
    expect(after[2]!.id).not.toBe(before[2]!.id);
    expect(remote.headFiles()).not.toContain(objectPath(before[2]!.id));
    expect(objectFiles(remote.headFiles())).toHaveLength(1 + 5);

    await b.sync();
    expect(b.fs.text("Big.bin")).toBe(a.fs.text("Big.bin"));
  });

  it("switches between chunked and single objects without leaving chunks behind", async () => {
    const { remote, a, b } = await twoDevices({ chunkSize: CHUNK });
    a.fs.setText("f.txt", "x".repeat(40));
    await a.sync();
    a.fs.setText("f.txt", "short");
    await a.sync();
    expect(objectFiles(remote.headFiles())).toHaveLength(1);
    expect(isLive(entryOf(a, "f.txt").entry) && "chunks" in entryOf(a, "f.txt").entry).toBe(false);
    a.fs.setText("f.txt", "y".repeat(33));
    await a.sync();
    expect(objectFiles(remote.headFiles())).toHaveLength(1 + 3);
    await b.sync();
    expect(b.fs.text("f.txt")).toBe("y".repeat(33));
  });

  it("keeps chunks on rename and removes them on delete", async () => {
    const { remote, a, b } = await twoDevices({ chunkSize: CHUNK });
    a.fs.setText("Old.bin", "z".repeat(50));
    await a.sync();
    await b.sync();
    const chunks = await chunksOf(a, "Old.bin");
    await a.fs.rename("Old.bin", "New.bin");
    a.store.recordRename("Old.bin", "New.bin");
    await a.sync();
    expect(entryOf(a, "New.bin").entry).toMatchObject({ path: "New.bin", chunks: 4 });
    expect((await chunksOf(a, "New.bin")).map((c) => c.id)).toEqual(chunks.map((c) => c.id));
    await b.sync();
    expect(b.fs.text("New.bin")).toBe("z".repeat(50));

    await a.fs.trash("New.bin");
    await a.sync();
    expect(objectFiles(remote.headFiles())).toEqual([]);
    await b.sync();
    expect(await b.fs.exists("New.bin")).toBe(false);
  });

  it("restores older versions of a chunked file", async () => {
    const { a } = await twoDevices({ chunkSize: CHUNK });
    a.fs.setText("Long.md", "first ".repeat(10));
    await a.sync();
    a.fs.setText("Long.md", "second ".repeat(10));
    await a.sync();
    const history = new VersionHistory({ crypto, fs: a.fs, remote: a.remote, store: a.store, getKeys: () => a.keys });
    const versions = await history.list("Long.md", 10);
    const texts = [];
    for (const v of versions) texts.push(utf8Decode((await history.load(v))!));
    expect(texts).toEqual(["second ".repeat(10), "first ".repeat(10)]);
  });

  it("never writes a file whose chunks were swapped or corrupted", async () => {
    const { remote, a, b } = await twoDevices({ chunkSize: CHUNK });
    a.fs.setText("Big.md", "1".repeat(16) + "2".repeat(16) + "3");
    await a.sync();
    const [c1, c2] = await chunksOf(a, "Big.md");
    const files = remote.commits.get(remote.head!)!.files;
    const first = files.get(objectPath(c1!.id))!;
    files.set(objectPath(c1!.id), files.get(objectPath(c2!.id))!);
    files.set(objectPath(c2!.id), first);

    const report = await b.sync().catch((e: unknown) => e);
    expect(await b.fs.exists("Big.md")).toBe(false);
    if (!(report instanceof Error)) expect((report as { failedLocalOps: number }).failedLocalOps).toBeGreaterThan(0);
  });

  it("rejects malformed chunk indexes", () => {
    const good = encodeChunkIndex([{ id: "a".repeat(32), size: 3, hash: "b".repeat(64) }]);
    expect(decodeChunkIndex(good)).toHaveLength(1);
    for (const bad of [
      { type: "obsidian-encrypted-sync-chunks", chunks: [] },
      { type: "other", chunks: [{ id: "a".repeat(32), size: 3, hash: "b".repeat(64) }] },
      { type: "obsidian-encrypted-sync-chunks", chunks: [{ id: "a".repeat(32), size: 0, hash: "b".repeat(64) }] },
      { type: "obsidian-encrypted-sync-chunks", chunks: [{ id: "a".repeat(32), size: 3, hash: "b".repeat(64) }, { id: "a".repeat(32), size: 3, hash: "b".repeat(64) }] },
      { type: "obsidian-encrypted-sync-chunks", chunks: [{ id: "a".repeat(32), size: 3, hash: "b".repeat(64), path: "x" }] },
    ]) {
      expect(() => decodeChunkIndex(new TextEncoder().encode(JSON.stringify(bad)))).toThrow();
    }
  });

  it("uploads chunks as separate blobs over the GitHub API without leaking plaintext", async () => {
    const server = new FakeGitHubServer();
    const client = new GitHubClient({ http: server, auth: new PersonalAccessTokenAuth(() => server.token), sleep: async () => undefined, minWriteIntervalMs: 0 });
    const remote = new GitHubRemoteRepository(new GitObjectsApi(client, server.owner, server.repo), { branch: "main" });
    const a = new Device(remote, undefined, { chunkSize: 1024 });
    await a.createVault();
    const b = new Device(remote, undefined, { chunkSize: 1024 });
    await b.connect();
    const secret = "Geheimer Inhalt einer großen Datei. ".repeat(200);
    a.fs.setText("Archiv/Grosse Datei.md", secret);
    await a.sync();
    await b.sync();
    expect(b.fs.text("Archiv/Grosse Datei.md")).toBe(secret);
    expect(server.requests.filter((r) => r.method === "POST" && r.url.endsWith("/git/blobs")).length).toBe(Math.ceil(new TextEncoder().encode(secret).length / 1024));
    expect(findLeaks(server.everything(), ["Geheimer Inhalt", "Grosse Datei", "Archiv"])).toEqual([]);
  });
});
