import { Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import { describeLocation, parseBackendLocation, type BackendLocation } from "../remote/BackendLocation";

interface GitHubTarget {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}
import { confirmDialog, formatBytes } from "./Modals";

type TargetState = Awaited<ReturnType<EncryptedSyncPlugin["inspectMoveTarget"]>>["state"];

const TARGET_TEXT: Record<TargetState, string> = {
  missing: "The repository does not exist (or the token cannot see it).",
  empty: "Empty repository – ready.",
  resumable: "Contains an unfinished move of this vault – it will be continued.",
  foreign: "The repository contains other files. Use an empty repository.",
  otherVault: "The repository contains a different encrypted vault.",
};

/** Continue the vault in a fresh repository to get rid of an ever-growing history. */
export class MoveVaultModal extends Modal {
  private target: GitHubTarget;
  private state: TargetState | null = null;
  private isPrivate = false;
  private statusEl: HTMLElement | null = null;
  private moveButton: ButtonComponent | null = null;
  private createButton: ButtonComponent | null = null;

  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
    const current = plugin.currentLocation();
    this.target = current.kind === "github" ? { owner: current.owner, repo: `${current.repo}-2`, branch: current.branch } : { owner: "", repo: "", branch: "main" };
  }

  override onOpen(): void {
    this.titleEl.setText("Move vault to a new repository");
    const { contentEl } = this;
    const current = this.plugin.currentLocation();
    const size = contentEl.createEl("p", { text: `Current location: ${describeLocation(current)} – size: loading…` });
    void this.plugin
      .repositorySize(true)
      .then((bytes) => size.setText(`Current location: ${describeLocation(current)} – size: ${bytes === null ? "unknown" : formatBytes(bytes)}`))
      .catch(() => size.setText(`Current location: ${describeLocation(current)} – size: unknown`));
    const list = contentEl.createEl("ul");
    for (const line of [
      "Git keeps every version forever, so the repository only grows. This copies the current state of all files (verified and re-encrypted) into a new, empty repository.",
      "Nothing is deleted: the current repository stays as a read-only archive. Version history and deleted files still reach into it.",
      "Your other devices stop syncing with the old repository and offer to switch with one click. The access token needs access to the new repository on every device.",
      "Devices with plugin version 0.2.x must be updated first.",
      "Large vaults need many GitHub requests; if a limit is reached, start the move again later – it continues where it stopped.",
    ]) {
      list.createEl("li", { text: line });
    }

    new Setting(contentEl).setName("Owner").addText((t) => t.setValue(this.target.owner).onChange((v) => this.update({ owner: v.trim() })));
    new Setting(contentEl).setName("New repository").addText((t) => t.setValue(this.target.repo).onChange((v) => this.update({ repo: v.trim() })));
    new Setting(contentEl).setName("Branch").addText((t) => t.setValue(this.target.branch).onChange((v) => this.update({ branch: v.trim() })));
    const check = new Setting(contentEl).addButton((b) => b.setButtonText("Check repository").onClick(() => void this.check()));
    check.addButton((b) => {
      this.createButton = b;
      b.setButtonText("Create private repository")
        .setDisabled(true)
        .onClick(() => void this.create());
    });
    this.statusEl = contentEl.createEl("p", { cls: "setting-item-description", text: "Check the new repository first." });
    new Setting(contentEl).addButton((b) => {
      this.moveButton = b;
      b.setButtonText("Move vault")
        .setCta()
        .setDisabled(true)
        .onClick(() => void this.move());
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private update(change: Partial<GitHubTarget>): void {
    this.target = { ...this.target, ...change };
    this.state = null;
    this.moveButton?.setDisabled(true);
    this.createButton?.setDisabled(true);
    this.statusEl?.setText("Check the new repository first.");
  }

  /** The entered target as a validated location (throws on invalid names). */
  private location(): BackendLocation {
    return parseBackendLocation({ kind: "github", ...this.target }, "target");
  }

  private async check(): Promise<void> {
    this.statusEl?.setText("Checking…");
    try {
      const result = await this.plugin.inspectMoveTarget(this.location());
      this.state = result.state;
      this.isPrivate = result.isPrivate;
      const visibility = result.state === "missing" ? "" : result.isPrivate ? " (private)" : " ⚠ This repository is PUBLIC: everyone can see its encrypted data and metadata (file count, sizes, change times).";
      this.statusEl?.setText(TARGET_TEXT[this.state] + visibility);
      this.moveButton?.setDisabled(this.state !== "empty" && this.state !== "resumable");
      this.createButton?.setDisabled(this.state !== "missing");
    } catch (error: unknown) {
      this.statusEl?.setText(`Check failed: ${describeError(error)}`);
    }
  }

  private async create(): Promise<void> {
    try {
      await this.plugin.createMoveTarget(this.location());
      new Notice(`Private repository ${this.target.owner}/${this.target.repo} created.`);
      await this.check();
    } catch (error: unknown) {
      this.statusEl?.setText(`The repository could not be created (${describeError(error)}). Create an empty private repository on GitHub and check again.`);
    }
  }

  private async move(): Promise<void> {
    if (this.state !== "empty" && this.state !== "resumable") return;
    const t = this.target;
    const ok = await confirmDialog(
      this.app,
      "Move the vault?",
      [`All files are copied to ${t.owner}/${t.repo} (${t.branch}). The current repository is kept as an archive and no longer synchronised.`, "Other devices will ask to switch."],
      "Move vault",
    );
    if (!ok) return;
    if (!this.isPrivate) {
      const confirmed = await confirmDialog(
        this.app,
        "Use a PUBLIC repository?",
        ["The contents stay encrypted, but everyone can download them and see metadata such as the number of files, their approximate sizes and when they change.", "A private repository is strongly recommended."],
        "Use public repository",
        true,
      );
      if (!confirmed) return;
    }
    const { contentEl } = this;
    contentEl.empty();
    const progress = contentEl.createEl("progress", { cls: "encrypted-sync-progress" });
    const label = contentEl.createEl("p", { text: "Synchronising first…" });
    try {
      const copied = await this.plugin.moveToRepository(this.location(), (done, total) => {
        progress.max = Math.max(1, total);
        progress.value = done;
        label.setText(`${done} / ${total} files copied`);
      });
      contentEl.empty();
      contentEl.createEl("p", { text: `✓ The vault now lives in ${t.owner}/${t.repo} (${copied} files copied). This device already switched.` });
      contentEl.createEl("p", { cls: "setting-item-description", text: "The old repository is an archive now. Delete it on GitHub only if you no longer need its history." });
    } catch (error: unknown) {
      contentEl.empty();
      contentEl.createEl("p", { cls: "mod-warning", text: `The move did not complete: ${describeError(error)}` });
      contentEl.createEl("p", { text: "Nothing was lost. The vault still syncs with the current repository; start the move again to continue." });
    }
    new Setting(contentEl).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }
}
