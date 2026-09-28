import { Modal, Notice, Setting, TFile } from "obsidian";
import type EncryptedSyncPlugin from "../main";
import type { ActivityEntry } from "../state/ActivityLog";
import type { FileChange, FileChangeAction } from "../sync/SyncEngine";
import { confirmDialog } from "./Modals";

const ACTION_TEXT: Record<FileChangeAction, string> = {
  downloaded: "↓ downloaded",
  uploaded: "↑ uploaded",
  movedLocally: "→ moved here",
  movedRemotely: "→ move uploaded",
  deletedLocally: "🗑 moved to trash here",
  deletedRemotely: "🗑 deletion uploaded",
  conflict: "⚠ conflict",
  restored: "↺ restored",
  trashed: "🗑 moved to trash",
};

/** What synchronisation did on this device, newest first (local log, never uploaded). */
export class ActivityModal extends Modal {
  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.titleEl.setText("Sync activity");
    this.modalEl.addClass("encrypted-sync-history");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const entries = this.plugin.activity.entries;
    if (entries.length === 0) {
      contentEl.createEl("p", { text: "No activity recorded yet. Every synchronisation that changes files is listed here." });
      return;
    }
    contentEl.createEl("p", { cls: "setting-item-description", text: "Stored only on this device. Click a file to open it." });
    const list = contentEl.createDiv({ cls: "encrypted-sync-activity" });
    for (const entry of entries) this.renderEntry(list, entry);
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Clear log")
        .setWarning()
        .onClick(async () => {
          if (!(await confirmDialog(this.app, "Clear the activity log?", ["Only this list is removed; no files are affected."], "Clear", true))) return;
          await this.plugin.activity.clear();
          this.render();
        }),
    );
  }

  private renderEntry(list: HTMLElement, entry: ActivityEntry): void {
    const details = list.createEl("details", { cls: `encrypted-sync-activity-${entry.kind}` });
    const summary = details.createEl("summary");
    summary.createSpan({ cls: "encrypted-sync-activity-time", text: new Date(entry.time).toLocaleString() });
    summary.createSpan({ text: ` ${entry.kind === "error" ? "⚠ " : ""}${entry.summary}` });
    if (entry.changes.length === 0) return;
    const ul = details.createEl("ul");
    for (const change of entry.changes) this.renderChange(ul, change);
    if (entry.omitted > 0) ul.createEl("li", { text: `… and ${entry.omitted} more` });
  }

  private renderChange(ul: HTMLElement, change: FileChange): void {
    const li = ul.createEl("li");
    li.createSpan({ cls: "encrypted-sync-activity-action", text: `${ACTION_TEXT[change.action]} ` });
    const link = li.createEl("a", { text: change.path, href: "#" });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openFile(change.path);
    });
    if (change.other) li.createSpan({ text: change.action === "conflict" ? ` (copy: ${change.other})` : ` (from ${change.other})` });
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("This file no longer exists at that path.");
      return;
    }
    this.close();
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}
