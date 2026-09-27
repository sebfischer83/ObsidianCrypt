import { Modal, Notice, Setting } from "obsidian";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import type { FileVersion } from "../sync/VersionHistory";
import { basename } from "../vault/PathUtils";
import { confirmDialog, formatBytes } from "./Modals";

/** Longest text shown in the preview (the restore itself always uses the complete version). */
const MAX_PREVIEW_CHARS = 200_000;

/**
 * Lists earlier versions of a note from the encrypted remote history; previews and restores them.
 * Versions are downloaded and decrypted only when previewed or restored.
 */
export class VersionHistoryModal extends Modal {
  private versions: FileVersion[] = [];
  private readonly contents = new Map<string, Uint8Array | null>();
  private readonly rows = new Map<string, Setting>();
  private currentHash: string | null = null;
  private previewEl: HTMLElement | null = null;
  private busy = false;

  constructor(
    private readonly plugin: EncryptedSyncPlugin,
    private readonly path: string,
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Version history: ${basename(this.path)}`);
    this.modalEl.addClass("encrypted-sync-history");
    this.contentEl.createEl("p", { text: "Loading versions…" });
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.contents.clear();
  }

  private async load(): Promise<void> {
    try {
      this.versions = await this.plugin.versionHistory().list(this.path, this.plugin.settings.versionHistoryLimit);
      this.currentHash = await this.plugin.crypto.hash(await this.plugin.fs.read(this.path));
    } catch (error: unknown) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { cls: "mod-warning", text: `Versions could not be loaded: ${describeError(error)}` });
      return;
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.rows.clear();
    if (this.versions.length === 0) {
      contentEl.createEl("p", { text: "No versions yet. A version is created each time a change to this note is synchronised." });
      return;
    }
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Versions from the encrypted GitHub history, newest first. Restoring replaces the note's content; the current content stays available as a version.",
    });
    const list = contentEl.createDiv({ cls: "encrypted-sync-history-list" });
    for (const version of this.versions) {
      const row = new Setting(list).setName(new Date(version.date).toLocaleString());
      row.addButton((b) => b.setButtonText("Preview").onClick(() => void this.preview(version)));
      row.addButton((b) => b.setButtonText("Restore as copy").onClick(() => void this.restore(version, true)));
      row.addButton((b) => b.setButtonText("Restore").setCta().onClick(() => void this.restore(version, false)));
      this.rows.set(version.commit, row);
      this.describe(version);
    }
    this.previewEl = contentEl.createDiv({ cls: "encrypted-sync-history-preview" });
  }

  private describe(version: FileVersion): void {
    const parts: string[] = [];
    if (version === this.versions[0]) parts.push("Latest synchronised version");
    if (version.device) parts.push(version.device === this.plugin.deviceId ? "this device" : `device ${version.device.slice(0, 8)}`);
    const content = this.contents.get(version.commit);
    if (content === null) parts.push("not available (note deleted in this sync)");
    else if (content) parts.push(formatBytes(content.length));
    this.rows.get(version.commit)?.setDesc(parts.join(" · "));
  }

  /** Downloads and decrypts a version once; null if the note did not exist in that commit. */
  private async content(version: FileVersion): Promise<Uint8Array | null> {
    if (this.contents.has(version.commit)) return this.contents.get(version.commit) ?? null;
    const content = await this.plugin.versionHistory().load(version);
    this.contents.set(version.commit, content);
    this.describe(version);
    if (content && this.currentHash && (await this.plugin.crypto.hash(content)) === this.currentHash) {
      const row = this.rows.get(version.commit);
      row?.descEl.appendText(" · same as the current content");
    }
    return content;
  }

  private async preview(version: FileVersion): Promise<void> {
    if (!this.previewEl) return;
    const target = this.previewEl;
    target.empty();
    target.createEl("p", { text: "Decrypting…" });
    try {
      const content = await this.content(version);
      target.empty();
      target.createEl("h4", { text: new Date(version.date).toLocaleString() });
      if (!content) {
        target.createEl("p", { text: "This version is not available: the note was deleted in this sync." });
        return;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(content);
      target.createEl("pre", { cls: "encrypted-sync-history-text", text: text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text });
    } catch (error: unknown) {
      target.empty();
      target.createEl("p", { cls: "mod-warning", text: describeError(error) });
    }
  }

  private async restore(version: FileVersion, asCopy: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const content = await this.content(version);
      if (!content) {
        new Notice("This version is not available: the note was deleted in this sync.");
        return;
      }
      const when = new Date(version.date).toLocaleString();
      if (asCopy) {
        const copy = await this.plugin.restoreVersionAsCopy(this.path, version, content);
        new Notice(`Version from ${when} restored as "${basename(copy)}".`);
        return;
      }
      const confirmed = await confirmDialog(
        this.app,
        "Restore this version?",
        [`The content of "${basename(this.path)}" is replaced by the version from ${when}.`, "The current content stays available in the version history."],
        "Restore",
      );
      if (!confirmed) return;
      const outcome = await this.plugin.restoreVersion(this.path, version, content);
      new Notice(outcome === "unchanged" ? "The note already has this content." : `Version from ${when} restored.`);
      this.close();
    } catch (error: unknown) {
      new Notice(describeError(error), 10000);
    } finally {
      this.busy = false;
    }
  }
}
