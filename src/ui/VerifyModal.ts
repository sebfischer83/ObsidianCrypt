import { Modal, Setting } from "obsidian";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import type { VerifyReport } from "../sync/RepositoryVerifier";
import { formatBytes } from "./Modals";

/** Runs the read-only repository check with progress and cancel. */
export class VerifyModal extends Modal {
  private cancelled = false;
  private running = false;

  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.titleEl.setText("Verify repository");
    const files = Object.values(this.plugin.store.state.remote?.entries ?? {}).filter((e) => !("deleted" in e)).length;
    this.contentEl.createEl("p", {
      text: "Downloads and decrypts every file in the repository and checks it against the encrypted manifest. Nothing is changed, locally or on GitHub.",
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `About ${files} file(s), roughly one GitHub request each (GitHub allows 5000 requests per hour). Large vaults take a while.`,
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Start").setCta().onClick(() => void this.run()));
  }

  override onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    const { contentEl } = this;
    contentEl.empty();
    const progress = contentEl.createEl("progress", { cls: "encrypted-sync-progress" });
    const label = contentEl.createEl("p", { text: "Checking configuration and manifest…" });
    new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => (this.cancelled = true)));
    try {
      const report = await this.plugin.verifyRepository(
        (done, total) => {
          progress.max = Math.max(1, total);
          progress.value = done;
          label.setText(`${done} / ${total} files checked`);
        },
        () => this.cancelled,
      );
      this.renderReport(report);
    } catch (error: unknown) {
      contentEl.empty();
      contentEl.createEl("p", { cls: "mod-warning", text: `Verification failed: ${describeError(error)}` });
    } finally {
      this.running = false;
    }
  }

  private renderReport(report: VerifyReport): void {
    const { contentEl } = this;
    contentEl.empty();
    const healthy = report.problems.length === 0 && report.stopped === null;
    contentEl.createEl("p", {
      cls: healthy ? "" : "mod-warning",
      text: healthy
        ? `✓ All ${report.verified} files verified (${formatBytes(report.totalBytes)}). Configuration and manifest are intact.`
        : report.problems.length > 0
          ? `⚠ ${report.problems.length} file(s) failed the check.`
          : `Stopped after ${report.verified} of ${report.files} files: ${report.stopped}`,
    });
    const rows: Array<[string, string]> = [
      ["Commit", report.commit.slice(0, 12)],
      ["Manifest version", String(report.manifestVersion)],
      ["Files verified", `${report.verified} / ${report.files}`],
      ["Unreferenced objects", report.treeComplete ? String(report.orphans) : "unknown (listing truncated)"],
    ];
    if (report.stopped && report.problems.length > 0) rows.push(["Stopped", report.stopped]);
    for (const [name, value] of rows) new Setting(contentEl).setName(name).setDesc(value);
    if (report.problems.length > 0) {
      contentEl.createEl("h4", { text: "Problems" });
      const list = contentEl.createEl("ul");
      for (const p of report.problems) list.createEl("li", { text: `${p.path} – ${p.problem === "missing" ? "object missing in the repository" : "corrupted or manipulated"}` });
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Your local files are not affected. If a local copy exists, changing it slightly re-uploads it; otherwise earlier versions may be available in the version history.",
      });
    }
    if (report.orphans > 0) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "Unreferenced objects are harmless leftovers (e.g. from an interrupted cleanup) and take only space." });
    }
    new Setting(contentEl).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }
}
