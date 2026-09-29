import { describe, expect, it } from "vitest";
import { IgnoreMatcher } from "../src/vault/IgnoreMatcher";
import { SyncFilter } from "../src/vault/SyncFilter";
import { conflictPath } from "../src/sync/ConflictNaming";
import { FileStateRepository, type BlobFileStore } from "../src/state/StateRepository";
import { newLocalState } from "../src/state/LocalState";
import { SyncStateStore } from "../src/state/SyncStateStore";
import { SyncMutex } from "../src/sync/SyncMutex";
import { isValidVaultPath, normalizeVaultPath } from "../src/vault/PathUtils";
import { crypto, DEFAULT_FILTER } from "./fakes/harness";

describe("ignore rules (.vaultsyncignore)", () => {
  const m = new IgnoreMatcher([".trash/", ".obsidian/workspace.json", "Temp/", "*.tmp", "# comment", "", "/Root.md", "docs/**/draft.md", "!keep.tmp"]);

  it.each([
    [".trash/x.md", true],
    [".obsidian/workspace.json", true],
    ["Temp/a.md", true],
    ["deep/Temp/a.md", true],
    ["a.tmp", true],
    ["x/y/z.tmp", true],
    ["keep.tmp", false],
    ["Root.md", true],
    ["sub/Root.md", false],
    ["docs/a/b/draft.md", true],
    ["docs/draft.md", true],
    ["Temporary.md", false],
    ["notes/a.md", false],
  ])("%s → ignored=%s", (path, expected) => {
    expect(m.isIgnored(path)).toBe(expected);
  });
});

describe("sync filter", () => {
  const filter = new SyncFilter(DEFAULT_FILTER);
  it("always excludes the own plugin folder and .git", () => {
    expect(filter.includes(".obsidian/plugins/encrypted-github-sync/data.json")).toBe(false);
    expect(filter.shouldDescend(".obsidian/plugins/encrypted-github-sync")).toBe(false);
    expect(filter.includes(".git/config")).toBe(false);
  });
  it("syncs the default .obsidian core settings only", () => {
    expect(filter.includes(".obsidian/app.json")).toBe(true);
    expect(filter.includes(".obsidian/appearance.json")).toBe(true);
    expect(filter.includes(".obsidian/hotkeys.json")).toBe(true);
    expect(filter.includes(".obsidian/workspace.json")).toBe(false);
    expect(filter.includes(".obsidian/plugins/other/main.js")).toBe(false);
    expect(new SyncFilter({ ...DEFAULT_FILTER, syncPlugins: true }).includes(".obsidian/plugins/other/main.js")).toBe(true);
    expect(new SyncFilter({ ...DEFAULT_FILTER, syncConfigDir: false }).includes(".obsidian/app.json")).toBe(false);
  });
  it("includes the ignore file itself and excludes temp files", () => {
    expect(filter.includes(".vaultsyncignore")).toBe(true);
    expect(filter.includes("a.md.vaultsync-tmp")).toBe(false);
    expect(filter.includes(".trash/a.md")).toBe(false);
  });
});

describe("paths", () => {
  it("normalises and validates", () => {
    expect(normalizeVaultPath("\\a\\\\b/")).toBe("a/b");
    expect(isValidVaultPath("a/b.md")).toBe(true);
    expect(isValidVaultPath("a/../b.md")).toBe(false);
  });
  it("conflict names", () => {
    const taken = new Set(["note (conflict 2026-09-26 19d359f8).md"]);
    const now = Date.UTC(2026, 8, 26, 12);
    expect(conflictPath("Kunden/Note.md", now, "19d359f8-aaaa", () => false)).toBe("Kunden/Note (conflict 2026-09-26 19d359f8).md");
    expect(conflictPath("Note.md", now, "19d359f8-aaaa", (p) => taken.has(p.toLowerCase()))).toBe("Note (conflict 2026-09-26 19d359f8 2).md");
    expect(conflictPath(".vaultsyncignore", now, "19d359f8", () => false)).toBe(".vaultsyncignore (conflict 2026-09-26 19d359f8)");
  });
});

class MapStore implements BlobFileStore {
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

describe("state persistence", () => {
  const device = "19d359f8-0000-4000-8000-000000000000";

  it("round-trips and survives a torn primary write", async () => {
    const store = new MapStore();
    const repo = new FileStateRepository(store, crypto, "state.json", device);
    const state = newLocalState(device);
    state.lastManifestVersion = 7;
    await repo.save(state);
    expect((await repo.load())?.lastManifestVersion).toBe(7);
    const primary = store.files.get("state.json") as Uint8Array;
    store.files.set("state.json", primary.subarray(0, primary.length / 2));
    expect((await repo.load())?.lastManifestVersion).toBe(7);
  });

  it("rejects state copied from another device", async () => {
    const store = new MapStore();
    await new FileStateRepository(store, crypto, "state.json", device).save(newLocalState(device));
    const reasons: string[] = [];
    const other = new FileStateRepository(store, crypto, "state.json", "841a07ae-0000-4000-8000-000000000000", (r) => reasons.push(r));
    expect(await other.load()).toBeNull();
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("rename events keep object identity (files and folders)", async () => {
    const store = await SyncStateStore.open(new FileStateRepository(new MapStore(), crypto, "s.json", device), device);
    store.state.localMap = { "a.md": "1".repeat(32), "Dir/b.md": "2".repeat(32), "Dir/Sub/c.md": "3".repeat(32) };
    store.recordRename("a.md", "x/a2.md");
    store.recordRename("Dir", "Folder");
    expect(store.state.localMap).toEqual({ "x/a2.md": "1".repeat(32), "Folder/b.md": "2".repeat(32), "Folder/Sub/c.md": "3".repeat(32) });
  });
});

describe("sync mutex (§18)", () => {
  it("never runs two syncs at once and records the request", async () => {
    const mutex = new SyncMutex();
    let release: () => void = () => undefined;
    const first = mutex.run(() => new Promise<void>((r) => (release = r)));
    const second = await mutex.run(async () => "should not run");
    expect(second.ran).toBe(false);
    expect(mutex.syncRequested).toBe(true);
    release();
    await first;
    expect(mutex.takeRequest()).toBe(true);
    expect(mutex.isRunning).toBe(false);
  });
});

describe("ignore rules are safe against pathological patterns (M1)", () => {
  it("matches in linear time where a regex would backtrack for minutes", () => {
    const m = new IgnoreMatcher(["*a*a*a*a*a*a*b", "**/**/**/**/**/x", "[z-a]", "a**b"]);
    const started = Date.now();
    expect(m.isIgnored("a".repeat(5000))).toBe(false);
    expect(m.isIgnored(Array.from({ length: 200 }, () => "d").join("/"))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(m.isIgnored("aaaaaaab")).toBe(true);
    expect(m.isIgnored("d/d/d/x")).toBe(true);
    expect(m.isIgnored("z")).toBe(false);
    // "**" inside a name behaves like "*": it never crosses folders.
    expect(m.isIgnored("axxb")).toBe(true);
    expect(m.isIgnored("a/y/b")).toBe(false);
  });

  it("keeps the documented semantics", () => {
    const m = new IgnoreMatcher(["*.tmp", "Temp/", "/Inbox.md", "docs/**/draft.md", "!keep.tmp", "cache/**", "[!a]b.md", "\\#hash.md"]);
    expect(m.isIgnored("x/y/file.tmp")).toBe(true);
    expect(m.isIgnored("keep.tmp")).toBe(false);
    expect(m.isIgnored("a/Temp/note.md")).toBe(true);
    expect(m.isIgnored("Temp")).toBe(false);
    expect(m.isIgnored("Inbox.md")).toBe(true);
    expect(m.isIgnored("sub/Inbox.md")).toBe(false);
    expect(m.isIgnored("docs/draft.md")).toBe(true);
    expect(m.isIgnored("docs/a/b/draft.md")).toBe(true);
    expect(m.isIgnored("cache/x.md")).toBe(true);
    expect(m.isIgnored("cache")).toBe(false);
    expect(m.isIgnored("cb.md")).toBe(true);
    expect(m.isIgnored("ab.md")).toBe(false);
    expect(m.isIgnored("#hash.md")).toBe(true);
    expect(m.isFolderIgnored("x/Temp")).toBe(false); // negations exist → never skip descending
  });
});
