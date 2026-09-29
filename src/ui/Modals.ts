import { Modal, Notice, Setting, type App } from "obsidian";
import { describeError } from "../errors/VaultSyncError";

/** Promise-based confirmation dialog. */
export function confirmDialog(app: App, title: string, body: string[], confirmText: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.titleEl.setText(title);
        for (const line of body) this.contentEl.createEl("p", { text: line });
        new Setting(this.contentEl)
          .addButton((b) =>
            b.setButtonText("Cancel").onClick(() => {
              decided = true;
              resolve(false);
              this.close();
            }),
          )
          .addButton((b) => {
            b.setButtonText(confirmText).onClick(() => {
              decided = true;
              resolve(true);
              this.close();
            });
            if (danger) b.setWarning();
            else b.setCta();
          });
      }
      override onClose(): void {
        this.contentEl.empty();
        if (!decided) resolve(false);
      }
    })(app);
    modal.open();
  });
}

export interface SecretPromptResult {
  readonly kind: "password" | "recoveryKey";
  readonly value: string;
}

/** Asks for the vault password (or alternatively the recovery key). Values are never stored by this modal. */
export function promptVaultSecret(app: App, title: string, description: string, allowRecoveryKey = true): Promise<SecretPromptResult | null> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new (class extends Modal {
      private kind: "password" | "recoveryKey" = "password";
      private value = "";
      override onOpen(): void {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", { text: description });
        const input = new Setting(this.contentEl).setName("Vault password").addText((t) => {
          t.inputEl.type = "password";
          t.inputEl.autocomplete = "current-password";
          t.onChange((v) => (this.value = v));
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this.submit();
          });
          window.setTimeout(() => t.inputEl.focus(), 0);
        });
        if (allowRecoveryKey) {
          new Setting(this.contentEl).setName("Use recovery key instead").addToggle((tg) =>
            tg.onChange((on) => {
              this.kind = on ? "recoveryKey" : "password";
              input.setName(on ? "Recovery key" : "Vault password");
            }),
          );
        }
        new Setting(this.contentEl).addButton((b) => b.setButtonText("Unlock").setCta().onClick(() => this.submit()));
      }
      submit(): void {
        if (!this.value) return;
        done = true;
        resolve({ kind: this.kind, value: this.value });
        this.value = "";
        this.close();
      }
      override onClose(): void {
        this.contentEl.empty();
        if (!done) resolve(null);
      }
    })(app);
    modal.open();
  });
}

/** Shows the recovery key once and requires the user to confirm they stored it externally. */
export function showRecoveryKey(app: App, recoveryKey: string): Promise<void> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.titleEl.setText("Save your recovery key");
        this.contentEl.createEl("p", {
          text: "This recovery key can unlock your encrypted vault if you forget the password. It is shown only now and is NOT stored anywhere – not on GitHub, not on this device.",
        });
        this.contentEl.createEl("pre", { text: recoveryKey, cls: "encrypted-sync-recovery-key" });
        this.contentEl.createEl("p", {
          cls: "mod-warning",
          text: "If you lose both the password and this recovery key, your encrypted data cannot be recovered by anyone.",
        });
        let saved = false;
        const confirm = new Setting(this.contentEl).addButton((b) =>
          b
            .setButtonText("I have stored the recovery key safely")
            .setCta()
            .setDisabled(true)
            .onClick(() => this.close()),
        );
        new Setting(this.contentEl).setName("I wrote it down or saved it in a password manager").addToggle((t) =>
          t.onChange((on) => {
            saved = on;
            const button = confirm.controlEl.querySelector("button");
            if (button) button.toggleAttribute("disabled", !saved);
          }),
        );
        new Setting(this.contentEl).addButton((b) => b.setButtonText("Copy to clipboard").onClick(() => void navigator.clipboard.writeText(recoveryKey)));
      }
      override onClose(): void {
        this.contentEl.empty();
        resolve();
      }
    })(app);
    modal.open();
  });
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Change the vault password: requires the current password; only the vault key is re-wrapped. */
export function openChangePasswordModal(app: App, minLength: number, change: (current: string, next: string) => Promise<void>): void {
  new (class extends Modal {
    override onOpen(): void {
      this.titleEl.setText("Change vault password");
      this.contentEl.createEl("p", { text: "Only the vault key is re-encrypted; your files are not re-uploaded. Other devices keep working. The old password is not revoked for older commits of the repository history." });
      let current = "";
      let next = "";
      let repeat = "";
      const field = (name: string, autocomplete: "current-password" | "new-password", set: (v: string) => void): void => {
        new Setting(this.contentEl).setName(name).addText((t) => {
          t.inputEl.type = "password";
          t.inputEl.autocomplete = autocomplete;
          t.onChange(set);
        });
      };
      field("Current password", "current-password", (v) => (current = v));
      field("New password", "new-password", (v) => (next = v));
      field("Repeat new password", "new-password", (v) => (repeat = v));
      new Setting(this.contentEl).addButton((b) =>
        b
          .setButtonText("Change password")
          .setCta()
          .onClick(async () => {
            if (next !== repeat) {
              new Notice("The new passwords do not match.");
              return;
            }
            if ([...next.normalize("NFC")].length < minLength) {
              new Notice(`The new password needs at least ${minLength} characters.`);
              return;
            }
            b.setDisabled(true);
            try {
              await change(current, next);
              current = next = repeat = "";
              new Notice("Vault password changed.");
              this.close();
            } catch (error: unknown) {
              new Notice(describeError(error), 8000);
              b.setDisabled(false);
            }
          }),
      );
    }
    override onClose(): void {
      this.contentEl.empty();
    }
  })(app).open();
}
