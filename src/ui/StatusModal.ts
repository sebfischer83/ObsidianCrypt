import { Modal, Setting } from "obsidian";
import type EncryptedSyncPlugin from "../main";
import type { SyncStatus } from "../sync/SyncController";
import { confirmDialog } from "./Modals";
import { statusText } from "./StatusBar";

/** Status rows shared by the status dialog and the settings tab. */
export function statusRows(plugin: EncryptedSyncPlugin, status: SyncStatus): Array<[string, string]> {
  const state = plugin.store.state;
  return [
    ["Status", statusText(status)],
    ["Details", status.message ?? "–"],
    ["Pending local changes", String(status.pending)],
    ["Conflicts", String(state.conflicts.length)],
    ["Last sync", state.lastSyncTime ? new Date(state.lastSyncTime).toLocaleString() : "never"],
    ["Last remote commit", state.lastRemoteCommit ? state.lastRemoteCommit.slice(0, 12) : "–"],
    ["Manifest version", String(state.lastManifestVersion)],
    ["Vault key", plugin.keyManager.isUnlocked ? "unlocked" : "locked"],
  ];
}

/**
 * Live status dialog (also the main entry point on mobile, where Obsidian has no status bar).
 * Re-renders on every status change and stays open while a sync runs.
 */
export class StatusModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.titleEl.setText("Encrypted sync status");
    this.unsubscribe = this.plugin.onStatusChange((status) => this.render(status));
    this.render(this.plugin.statusSummary());
  }

  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(status: SyncStatus): void {
    const { contentEl } = this;
    contentEl.empty();
    for (const [name, value] of statusRows(this.plugin, status)) new Setting(contentEl).setName(name).setDesc(value);
    const syncing = status.state === "syncing";
    const actions = new Setting(contentEl);
    actions.addButton((b) =>
      b
        .setButtonText(syncing ? "Syncing…" : "Sync now")
        .setCta()
        .setDisabled(syncing)
        .onClick(() => void this.plugin.syncCommand("full")),
    );
    if (this.plugin.store.state.conflicts.length > 0) {
      actions.addButton((b) =>
        b.setButtonText("Show conflicts").onClick(() => {
          this.close();
          this.plugin.openConflicts();
        }),
      );
    }
    if (status.state === "blocked") {
      contentEl.createEl("p", {
        cls: "mod-warning",
        text: "Synchronisation was stopped to protect your local files. Check the repository on GitHub before continuing.",
      });
      actions.addButton((b) =>
        b
          .setButtonText("Retry")
          .setWarning()
          .onClick(async () => {
            if (!(await confirmDialog(this.app, "Retry synchronisation?", ["Only continue if you understand why the repository changed."], "Retry", true))) return;
            void this.plugin.syncCommand("full");
          }),
      );
    }
  }
}
