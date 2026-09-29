import { Modal, Notice, Setting, type App } from "obsidian";
import { MIN_PASSWORD_LENGTH } from "../crypto/KeyManager";
import { describeError, logUnexpected } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import type { RemoteInspection } from "../sync/VaultSetup";
import { parseBackendLocation, type BackendLocation } from "../remote/BackendLocation";
import type { Credentials } from "../remote/Credentials";
import { formatBytes, showRecoveryKey } from "./Modals";

type Step = "repository" | "create" | "join";

const LOSS_WARNING =
  "If you lose both the vault password and the recovery key, the encrypted data cannot be recovered – by you, by GitHub or by the plugin author. There is no backdoor.";

/**
 * Guided setup: connect a repository, then either create a new encrypted vault (empty repository) or
 * join an existing one (second device). Nothing is uploaded before the user confirmed the summary.
 */
export class SetupWizard extends Modal {
  private step: Step = "repository";
  private owner: string;
  private repo: string;
  private branch: string;
  private token = "";
  private inspection: RemoteInspection | null = null;
  private busy = false;

  constructor(
    app: App,
    private readonly plugin: EncryptedSyncPlugin,
  ) {
    super(app);
    const current = plugin.settings.location;
    this.owner = current?.kind === "github" ? current.owner : "";
    this.repo = current?.kind === "github" ? current.repo : "";
    this.branch = current?.kind === "github" ? current.branch : "main";
    const credentials = plugin.getCredentials();
    this.token = credentials?.kind === "github" ? credentials.token : "";
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.token = "";
  }

  private render(): void {
    this.contentEl.empty();
    this.titleEl.setText("Encrypted GitHub Sync – setup");
    if (this.step === "repository") this.renderRepository();
    else if (this.step === "create") this.renderCreate();
    else this.renderJoin();
  }

  private renderRepository(): void {
    const el = this.contentEl;
    el.createEl("p", {
      text: "Your notes are encrypted on this device before anything is sent to GitHub. GitHub only stores encrypted objects with random names.",
    });
    new Setting(el).setName("Repository owner").setDesc("GitHub user or organisation").addText((t) => t.setValue(this.owner).onChange((v) => (this.owner = v.trim())));
    new Setting(el).setName("Repository name").addText((t) => t.setValue(this.repo).onChange((v) => (this.repo = v.trim())));
    new Setting(el).setName("Branch").addText((t) => t.setValue(this.branch).onChange((v) => (this.branch = v.trim() || "main")));
    new Setting(el)
      .setName("Access token")
      .setDesc("Fine-grained personal access token limited to this repository with 'Contents: Read and write'. Stored in the system keychain, never in the vault.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.setValue(this.token).onChange((v) => (this.token = v.trim()));
      });
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Check repository")
        .setCta()
        .onClick(() => void this.check()),
    );
  }

  private async check(): Promise<void> {
    if (this.busy) return;
    if (!this.owner || !this.repo || !this.token) {
      new Notice("Please fill in owner, repository and token.");
      return;
    }
    let location: BackendLocation;
    try {
      location = parseBackendLocation({ kind: "github", owner: this.owner, repo: this.repo, branch: this.branch }, "repository");
    } catch {
      new Notice("Owner, repository or branch name is not valid.");
      return;
    }
    const credentials: Credentials = { kind: "github", token: this.token };
    this.busy = true;
    try {
      const result = await this.plugin.inspect(location, credentials);
      if (result.check.access === "missing") {
        new Notice("The repository does not exist or the token cannot access it.", 8000);
        return;
      }
      if (!result.check.writable) {
        new Notice("The token has no write access to this repository.", 8000);
        return;
      }
      this.inspection = result.inspection;
      if (result.inspection.kind === "foreign") {
        new Notice("This repository/branch already contains other files. Use an empty repository for the encrypted vault.", 10000);
        return;
      }
      if (result.check.isPrivate === false) {
        new Notice("Warning: the repository is public. Contents stay encrypted, but anyone can see the number, sizes and change times of encrypted objects.", 12000);
      }
      this.plugin.setCredentials(location, credentials);
      if (!this.plugin.secrets.persistent) {
        new Notice(`The system keychain is not available${this.plugin.secrets.lastError ? ` (${describeError(this.plugin.secrets.lastError, [this.token])})` : ""}. The token is kept in memory for this session only.`, 12000);
      }
      await this.plugin.switchLocation(location);
      this.step = result.inspection.kind === "vault" ? "join" : "create";
      this.render();
    } catch (error: unknown) {
      new Notice(`Connection failed: ${describeError(error, [this.token])}`, 15000);
      logUnexpected(this.plugin.settings.debugLogging, "setup: check repository", error, [this.token]);
    } finally {
      this.busy = false;
    }
  }

  private renderCreate(): void {
    const el = this.contentEl;
    el.createEl("h3", { text: "Create a new encrypted vault" });
    el.createEl("p", { text: "The repository is empty. A random 256-bit vault key will be created and protected with your password." });
    let password = "";
    let confirm = "";
    new Setting(el)
      .setName("Vault password")
      .setDesc(`At least ${MIN_PASSWORD_LENGTH} characters. A long passphrase is recommended.`)
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "new-password";
        t.onChange((v) => (password = v));
      });
    new Setting(el).setName("Repeat password").addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "new-password";
      t.onChange((v) => (confirm = v));
    });
    el.createEl("p", { cls: "mod-warning", text: LOSS_WARNING });
    const summaryEl = el.createEl("p", { text: "Counting local files…" });
    void this.plugin.localSummary().then(
      (s) => {
        summaryEl.setText(
          `${s.files.toLocaleString()} files · ${formatBytes(s.bytes)} will be encrypted and uploaded.${s.tooLarge ? ` ${s.tooLarge} file(s) exceed the size limit and will be skipped.` : ""}`,
        );
      },
      (error: unknown) => summaryEl.setText(`Could not list files: ${describeError(error)}`),
    );
    new Setting(el)
      .addButton((b) => b.setButtonText("Back").onClick(() => ((this.step = "repository"), this.render())))
      .addButton((b) =>
        b
          .setButtonText("Encrypt and upload")
          .setCta()
          .onClick(async () => {
            if (this.busy) return;
            if (password !== confirm) {
              new Notice("The passwords do not match.");
              return;
            }
            if ([...password.normalize("NFC")].length < MIN_PASSWORD_LENGTH) {
              new Notice(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
              return;
            }
            this.busy = true;
            b.setDisabled(true).setButtonText("Deriving key…");
            try {
              const recoveryKey = await this.plugin.createNewVault(password);
              password = confirm = "";
              this.close();
              if (recoveryKey) await showRecoveryKey(this.app, recoveryKey);
              await this.plugin.syncCommand("full");
            } catch (error: unknown) {
              new Notice(`Setup failed: ${describeError(error, [this.token])}`, 15000);
              logUnexpected(this.plugin.settings.debugLogging, "setup: create vault", error, [this.token]);
              b.setDisabled(false).setButtonText("Encrypt and upload");
            } finally {
              this.busy = false;
            }
          }),
      );
  }

  private renderJoin(): void {
    const el = this.contentEl;
    el.createEl("h3", { text: "Connect to an existing encrypted vault" });
    el.createEl("p", {
      text: "Remote files will be downloaded and decrypted. Files that exist here and remotely with different content are kept as conflict copies. Nothing is deleted during the first synchronisation.",
    });
    let secret = "";
    let useRecovery = false;
    const input = new Setting(el).setName("Vault password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (secret = v));
    });
    new Setting(el).setName("Use recovery key instead").addToggle((tg) =>
      tg.onChange((on) => {
        useRecovery = on;
        input.setName(on ? "Recovery key" : "Vault password");
      }),
    );
    const summaryEl = el.createEl("p");
    void this.plugin.localSummary().then(
      (s) => summaryEl.setText(s.files > 0 ? `This vault already contains ${s.files.toLocaleString()} files (${formatBytes(s.bytes)}); they will be merged.` : "This vault is empty."),
      () => summaryEl.setText(""),
    );
    new Setting(el)
      .addButton((b) => b.setButtonText("Back").onClick(() => ((this.step = "repository"), this.render())))
      .addButton((b) =>
        b
          .setButtonText("Unlock and sync")
          .setCta()
          .onClick(async () => {
            if (this.busy || !secret) return;
            this.busy = true;
            b.setDisabled(true).setButtonText("Unlocking…");
            try {
              await this.plugin.connectVault(useRecovery ? { recoveryKey: secret } : { password: secret });
              secret = "";
              this.close();
              await this.plugin.syncCommand("full");
            } catch (error: unknown) {
              new Notice(`Connecting failed: ${describeError(error, [this.token])}`, 15000);
              logUnexpected(this.plugin.settings.debugLogging, "setup: connect vault", error, [this.token]);
              b.setDisabled(false).setButtonText("Unlock and sync");
            } finally {
              this.busy = false;
            }
          }),
      );
  }
}
