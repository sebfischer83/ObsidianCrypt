import { Modal, Notice, Setting, TFile, type App } from "obsidian";
import { describeError } from "../errors/VaultSyncError";
import type { ConflictRecord } from "../state/LocalState";
import type { ConflictSides } from "../sync/ConflictResolver";
import { renderDiff } from "./DiffView";
import { confirmDialog } from "./Modals";

const KIND_TEXT: Record<ConflictRecord["kind"], string> = {
  content: "Changed on two devices – both versions kept",
  localDeleteRemoteModify: "Deleted here, changed elsewhere – changed version restored",
  localModifyRemoteDelete: "Changed here, deleted elsewhere – your version kept",
  bothCreated: "Created on two devices – both files kept",
};

export interface ConflictActions {
  list(): ConflictRecord[];
  dismiss(id: string): Promise<void>;
  load(conflict: ConflictRecord): Promise<ConflictSides>;
  hash(data: Uint8Array): Promise<string>;
  /** Keep the canonical file, move the copy to the trash (both unchanged since compared). */
  keepSynced(conflict: ConflictRecord, copyHash: string, syncedHash: string): Promise<void>;
  /** Replace the canonical file with the copy, then move the copy to the trash. */
  keepCopy(conflict: ConflictRecord, copyHash: string, syncedHash: string): Promise<void>;
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
      text: "No version was discarded. Compare both versions and keep one, or merge them manually and mark the conflict as resolved. A discarded copy moves to the vault trash.",
    });
    for (const conflict of conflicts) {
      const setting = new Setting(contentEl)
        .setName(conflict.path)
        .setDesc(`${KIND_TEXT[conflict.kind]}${conflict.conflictPath ? ` · copy: ${conflict.conflictPath}` : ""} · ${new Date(conflict.detectedAt).toLocaleString()}`);
      if (conflict.conflictPath) {
        setting.addButton((b) =>
          b
            .setButtonText("Compare")
            .setCta()
            .onClick(() => new ConflictCompareModal(this.app, this.actions, conflict, () => this.render()).open()),
        );
      } else {
        setting.addButton((b) => b.setButtonText("Open").onClick(() => void openPath(this.app, conflict.path)));
      }
      setting.addButton((b) =>
        b.setButtonText("Resolved").onClick(async () => {
          await this.actions.dismiss(conflict.id);
          this.render();
        }),
      );
    }
  }
}

/** Side-by-side decision for a conflict with a preserved copy. */
class ConflictCompareModal extends Modal {
  constructor(
    app: App,
    private readonly actions: ConflictActions,
    private readonly conflict: ConflictRecord,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Compare: ${this.conflict.path}`);
    this.modalEl.addClass("encrypted-sync-history");
    void this.load();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    const { contentEl } = this;
    contentEl.createEl("p", { text: "Loading…" });
    let sides: ConflictSides;
    try {
      sides = await this.actions.load(this.conflict);
    } catch (error: unknown) {
      contentEl.empty();
      contentEl.createEl("p", { cls: "mod-warning", text: describeError(error) });
      return;
    }
    contentEl.empty();
    const copyPath = this.conflict.conflictPath as string;
    if (!sides.synced || !sides.copy) {
      contentEl.createEl("p", { text: `${!sides.synced ? this.conflict.path : copyPath} no longer exists, so there is nothing to compare. Mark the conflict as resolved if you are done.` });
      new Setting(contentEl).addButton((b) => b.setButtonText("Mark resolved").setCta().onClick(() => void this.finish(() => this.actions.dismiss(this.conflict.id), "Conflict marked as resolved.")));
      return;
    }
    const copy = sides.copy;
    const copyHash = await this.actions.hash(copy);
    const syncedHash = await this.actions.hash(sides.synced);
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `“−” lines are only in the synced version (${this.conflict.path}), “+” lines only in the copy (${copyPath}).`,
    });
    renderDiff(contentEl.createDiv(), sides.synced, copy, "synced version", "copy");

    new Setting(contentEl)
      .setName("Keep synced version")
      .setDesc("The copy moves to the vault trash.")
      .addButton((b) => b.setButtonText("Keep synced").onClick(() => void this.finish(() => this.actions.keepSynced(this.conflict, copyHash, syncedHash), "Kept the synced version; the copy is in the trash.")));
    new Setting(contentEl)
      .setName("Keep copy")
      .setDesc(`The copy's content replaces ${this.conflict.path}; the replaced content stays in the version history and the copy moves to the trash.`)
      .addButton((b) =>
        b.setButtonText("Keep copy").onClick(async () => {
          const ok = await confirmDialog(this.app, "Keep the copy?", [`The content of "${this.conflict.path}" is replaced by the copy.`, "The replaced content remains in the version history."], "Keep copy");
          if (ok) await this.finish(() => this.actions.keepCopy(this.conflict, copyHash, syncedHash), "Kept the copy.");
        }),
      );
    new Setting(contentEl)
      .setName("Merge manually")
      .setDesc("Opens both files side by side. Delete the copy and mark the conflict as resolved when you are done.")
      .addButton((b) =>
        b.setButtonText("Open side by side").onClick(async () => {
          this.close();
          await openPath(this.app, this.conflict.path);
          await openPath(this.app, copyPath, true);
        }),
      );
  }

  private async finish(action: () => Promise<void>, message: string): Promise<void> {
    try {
      await action();
      new Notice(message);
      this.close();
      this.onDone();
    } catch (error: unknown) {
      new Notice(describeError(error), 10000);
    }
  }
}

async function openPath(app: App, path: string, split = false): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice("File no longer exists.");
    return;
  }
  await (split ? app.workspace.getLeaf("split", "vertical") : app.workspace.getLeaf(true)).openFile(file);
}
