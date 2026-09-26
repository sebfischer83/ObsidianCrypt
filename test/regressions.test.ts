import { describe, expect, it } from "vitest";
import { SyncError } from "../src/errors/SyncError";
import { isLive } from "../src/manifest/Manifest";
import { MANIFEST_PATH } from "../src/remote/RemoteLayout";
import { SyncFilter, isPortablePath } from "../src/vault/SyncFilter";
import { DEFAULT_FILTER, twoDevices } from "./fakes/harness";

/** Regression tests for findings of the adversarial review. */
describe("review regressions", () => {
  it("a file skipped as too large does not later revert a remote edit", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Doc.md", "v1 " + "x".repeat(2000));
    await a.sync();
    await b.sync();
    a.reconfigure({ maxFileSize: 100 });
    b.fs.setText("Doc.md", "v2 from B " + "y".repeat(2000));
    await b.sync();
    await a.sync();
    a.reconfigure({ maxFileSize: 50 * 1024 * 1024 });
    await a.sync();
    await b.sync();
    expect(b.fs.text("Doc.md")?.startsWith("v2 from B")).toBe(true);
    expect(a.fs.text("Doc.md")?.startsWith("v2 from B")).toBe(true);
  });

  it("local delete vs remote modify never tombstones a version this device can not materialise", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("Note.md", "small");
    await a.sync();
    await b.sync();
    a.reconfigure({ maxFileSize: 100 });
    a.fs.remove("Note.md");
    b.fs.setText("Note.md", "grown on B " + "z".repeat(500));
    await b.sync();
    const report = await a.sync();
    expect(report.newConflicts.map((c) => c.kind)).toEqual(["localDeleteRemoteModify"]);
    await b.sync();
    expect(b.fs.text("Note.md")?.startsWith("grown on B")).toBe(true);
    const live = Object.values(b.store.state.remote?.entries ?? {}).filter(isLive);
    expect(live.map((e) => e.path)).toEqual(["Note.md"]);
    // And A does not keep trying to push the deletion.
    await a.sync();
    await b.sync();
    expect(b.fs.text("Note.md")?.startsWith("grown on B")).toBe(true);
  });

  it("an edit right after a download is never overwritten by a retry", async () => {
    const { a, b } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.setText("n.md", "v2 from A");
    await a.sync();
    b.fs.afterWrite = (path) => {
      b.fs.afterWrite = null;
      b.fs.setText(path, "typed on B right after download");
    };
    await b.sync();
    expect(b.fs.text("n.md")).toBe("typed on B right after download");
    await b.sync();
    await a.sync();
    const texts = Object.values(a.fs.snapshot()).sort();
    expect(texts).toEqual(["typed on B right after download", "v2 from A"]);
  });

  it("a replayed older manifest appended by an attacker is detected", async () => {
    const { a, b, remote } = await twoDevices();
    a.fs.setText("n.md", "v1");
    await a.sync();
    await b.sync(); // B knows manifest v1
    const oldManifest = remote.commits.get(remote.head as string)?.files.get(MANIFEST_PATH) as Uint8Array;
    a.fs.setText("n.md", "v2");
    a.fs.setText("m.md", "m");
    await a.sync();
    a.fs.setText("n.md", "v3");
    await a.sync();
    // Attacker (write access, no key) appends a commit that carries the v1 manifest again.
    const head = remote.head as string;
    const files = new Map(remote.commits.get(head)?.files);
    files.set(MANIFEST_PATH, oldManifest);
    const forged = "f".repeat(40);
    remote.commits.set(forged, { sha: forged, parent: head, files, message: "Encrypted vault sync: 1 change" });
    remote.forceSetHead(forged);
    const error = await b.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).blockReason).toBe("HistoryRewritten");
  });

  it("non-portable names and the own plugin folder in any case are never synchronised", () => {
    const filter = new SyncFilter({ ...DEFAULT_FILTER, syncPlugins: true });
    for (const bad of ["a:b.md", "CON.md", "nul", "trailing.", "space /x.md", "q?.md"]) expect(isPortablePath(bad), bad).toBe(false);
    for (const good of ["Kunden/Müller GmbH.md", "a-b c.md", "Note (conflict 2026-09-26 1a2b3c4d).md", ".vaultsyncignore"]) expect(isPortablePath(good), good).toBe(true);
    expect(filter.includes(".obsidian/Plugins/Encrypted-GitHub-Sync/data.json")).toBe(false);
    expect(filter.includes(".obsidian/plugins/other/data.json")).toBe(true);
  });
});
