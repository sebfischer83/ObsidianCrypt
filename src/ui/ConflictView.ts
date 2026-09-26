import { Modal, Notice, Setting, TFile, type App } from "obsidian";
import type { ConflictRecord } from "../state/LocalState";

const KIND_TEXT: Record<ConflictRecord["kind"], string> = {
  content: "Changed on two devices – both versions kept",
  localDeleteRemoteModify: "Deleted here, changed elsewhere – changed version restored",
  localModifyRemoteDelete: "Changed here, deleted elsewhere – your version kept",
  bothCreated: "Created on two devices – both files kept",
};

export interface ConflictActions {
  list(): ConflictRecord[];
  dismiss(id: string): Promise<void>;
}

/** Lists unresolved synchronisation conflicts. Resolving never deletes data permanently. */
export class ConflictView extends Modal {
  constructor(
    app: App,
    private readonly actions: ConflictActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Synchronisation conflicts");
    const conflicts = this.actions.list();
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "No unresolved conflicts." });
      return;
    }
    contentEl.createEl("p", {
      text: "No version was discarded. Compare the files, merge them manually if needed, then mark the conflict as resolved. Deleting a copy moves it to the vault trash.",
    });
    for (const conflict of conflicts) {
      const setting = new Setting(contentEl)
        .setName(conflict.path)
        .setDesc(`${KIND_TEXT[conflict.kind]}${conflict.conflictPath ? ` · copy: ${conflict.conflictPath}` : ""} · ${new Date(conflict.detectedAt).toLocaleString()}`)
        .addButton((b) => b.setButtonText("Open").onClick(() => void this.openPath(conflict.path)));
      if (conflict.conflictPath) {
        const copy = conflict.conflictPath;
        setting.addButton((b) => b.setButtonText("Open copy").onClick(() => void this.openPath(copy)));
        setting.addButton((b) =>
          b
            .setButtonText("Trash copy")
            .setWarning()
            .onClick(async () => {
              const file = this.app.vault.getFileByPath(copy);
              if (file) await this.app.vault.trash(file, false);
              await this.actions.dismiss(conflict.id);
              this.render();
            }),
        );
      }
      setting.addButton((b) =>
        b
          .setButtonText("Resolved")
          .setCta()
          .onClick(async () => {
            await this.actions.dismiss(conflict.id);
            this.render();
          }),
      );
    }
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("File no longer exists.");
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}
