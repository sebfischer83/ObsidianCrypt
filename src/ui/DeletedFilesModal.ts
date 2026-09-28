import { Modal, Notice, Setting } from "obsidian";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import type { DeletedFile, DeletedFiles, ResolvedDeletedFile } from "../sync/DeletedFiles";
import { decodeText } from "../util/diff";
import { formatBytes } from "./Modals";

/** Deleted files are looked up in the history in pages (a few requests each). */
const PAGE = 20;
const MAX_PREVIEW_CHARS = 100_000;

/** Lists files deleted on any device and restores them from the encrypted history. */
export class DeletedFilesModal extends Modal {
  private readonly deleted: DeletedFiles;
  private all: DeletedFile[] = [];
  private readonly resolved: Array<ResolvedDeletedFile | null> = [];
  private shown = 0;
  private filter = "";
  private listEl: HTMLElement | null = null;
  private moreEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private loading = false;

  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
    this.deleted = plugin.deletedFiles();
  }

  override onOpen(): void {
    this.titleEl.setText("Deleted files");
    this.modalEl.addClass("encrypted-sync-history");
    this.all = this.deleted.list();
    const { contentEl } = this;
    if (this.all.length === 0) {
      contentEl.createEl("p", { text: "No deleted files in the synchronised history." });
      return;
    }
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `${this.all.length} file(s) were deleted on your devices, most recent first. Restoring writes the last version back (next to it if the name is taken); nothing existing is overwritten.`,
    });
    new Setting(contentEl).setName("Filter").addText((t) =>
      t.setPlaceholder("Part of the path").onChange((v) => {
        this.filter = v.toLowerCase();
        this.renderList();
      }),
    );
    this.listEl = contentEl.createDiv({ cls: "encrypted-sync-history-list" });
    this.moreEl = contentEl.createDiv();
    this.previewEl = contentEl.createDiv({ cls: "encrypted-sync-history-preview" });
    void this.loadMore();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async loadMore(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.renderMore("Looking up deleted files…");
    try {
      const next = this.all.slice(this.shown, this.shown + PAGE);
      for (const file of next) this.resolved.push(await this.deleted.resolve(file).catch(() => null));
      this.shown += next.length;
    } catch (error: unknown) {
      new Notice(describeError(error), 8000);
    } finally {
      this.loading = false;
    }
    this.renderList();
    this.renderMore(null);
  }

  private renderMore(message: string | null): void {
    if (!this.moreEl) return;
    this.moreEl.empty();
    if (message) {
      this.moreEl.createEl("p", { text: message });
      return;
    }
    if (this.shown < this.all.length) {
      new Setting(this.moreEl).setDesc(`${this.shown} of ${this.all.length} shown`).addButton((b) => b.setButtonText("Load more").onClick(() => void this.loadMore()));
    }
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    let visible = 0;
    for (const file of this.resolved) {
      if (!file || (this.filter && !file.path.toLowerCase().includes(this.filter))) continue;
      visible++;
      const device = file.deletedBy === this.plugin.deviceId ? "this device" : `device ${file.deletedBy.slice(0, 8)}`;
      new Setting(list)
        .setName(file.path)
        .setDesc(`Deleted ${new Date(file.deletedAt).toLocaleString()} on ${device} · ${formatBytes(file.size)}`)
        .addButton((b) => b.setButtonText("Preview").onClick(() => void this.preview(file)))
        .addButton((b) => b.setButtonText("Restore").setCta().onClick(() => void this.restore(file)));
    }
    const unresolved = this.resolved.filter((r) => r === null).length;
    if (unresolved > 0) list.createEl("p", { cls: "setting-item-description", text: `${unresolved} deleted file(s) could not be found in the history.` });
    if (visible === 0 && this.resolved.length > 0) list.createEl("p", { text: "No matching files among those loaded." });
  }

  private async preview(file: ResolvedDeletedFile): Promise<void> {
    const target = this.previewEl;
    if (!target) return;
    target.empty();
    target.createEl("p", { text: "Decrypting…" });
    try {
      const content = await this.deleted.load(file);
      target.empty();
      target.createEl("h4", { text: file.path });
      const text = decodeText(content);
      if (text === null) target.createEl("p", { text: `Binary file, ${formatBytes(content.length)}.` });
      else target.createEl("pre", { cls: "encrypted-sync-history-text", text: text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text });
    } catch (error: unknown) {
      target.empty();
      target.createEl("p", { cls: "mod-warning", text: describeError(error) });
    }
  }

  private async restore(file: ResolvedDeletedFile): Promise<void> {
    try {
      const path = await this.plugin.restoreDeletedFile(this.deleted, file);
      new Notice(path === file.path ? `Restored "${path}".` : `Restored as "${path}" (the original name is taken).`);
    } catch (error: unknown) {
      new Notice(describeError(error), 10000);
    }
  }
}
