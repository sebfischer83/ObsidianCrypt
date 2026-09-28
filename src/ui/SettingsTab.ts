import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent } from "obsidian";
import type { SyncStatus } from "../sync/SyncController";
import { statusRows } from "./StatusModal";
import { MIN_PASSWORD_LENGTH } from "../crypto/KeyManager";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import { MAX_FILE_SIZE_MB_LIMIT } from "../settings";
import { MAX_VERSION_LIMIT } from "../sync/VersionHistory";
import { IGNORE_FILE } from "../vault/SyncFilter";
import { confirmDialog, formatBytes } from "./Modals";
import { SetupWizard } from "./SetupWizard";
import { statusText } from "./StatusBar";

export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: EncryptedSyncPlugin,
  ) {
    super(app, plugin);
  }

  private unsubscribe: (() => void) | null = null;
  private liveRows = new Map<string, Setting>();
  private syncButton: ButtonComponent | null = null;
  private statusSetting: Setting | null = null;

  override hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Updates the status parts in place (no full re-render, so text inputs keep their state). */
  private renderLive(status: SyncStatus): void {
    if (this.statusSetting) {
      this.statusSetting.setName(statusText(status));
      const state = this.plugin.store.state;
      this.statusSetting.setDesc(
        [status.message, state.lastSyncTime ? `Last sync: ${new Date(state.lastSyncTime).toLocaleString()}` : "Not synchronised yet"].filter(Boolean).join(" · "),
      );
    }
    const syncing = status.state === "syncing";
    this.syncButton?.setDisabled(syncing || !this.plugin.isConfigured()).setButtonText(syncing ? "Syncing…" : "Sync now");
    for (const [name, value] of statusRows(this.plugin, status)) this.liveRows.get(name)?.setDesc(value);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.unsubscribe?.();
    this.liveRows = new Map();
    const s = this.plugin.settings;
    const save = async (): Promise<void> => this.plugin.saveSettings();

    // ── Status (live) ──
    this.statusSetting = new Setting(containerEl)
      .addButton((b) => {
        this.syncButton = b;
        b.setButtonText("Sync now")
          .setCta()
          .onClick(() => void this.plugin.syncCommand("full"));
      })
      .addButton((b) => b.setButtonText("Details").onClick(() => this.plugin.openStatus()));

    // ── GitHub ──
    new Setting(containerEl).setName("GitHub").setHeading();
    new Setting(containerEl)
      .setName("Repository")
      .setDesc(s.owner && s.repo ? `${s.owner}/${s.repo} (branch ${s.branch})` : "Not configured")
      .addButton((b) => b.setButtonText(this.plugin.isConfigured() ? "Change / reconnect" : "Set up").setCta().onClick(() => new SetupWizard(this.app, this.plugin).open()));
    new Setting(containerEl)
      .setName("Access token")
      .setDesc(this.plugin.secrets.persistent ? "Stored in the system keychain (never in data.json or the vault)." : "Secret storage unavailable: the token is kept in memory only for this session.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(this.plugin.getToken() ? "•••••••• (stored)" : "github_pat_…");
        t.inputEl.addEventListener("change", () => {
          if (t.getValue()) {
            this.plugin.setToken(t.getValue());
            t.setValue("");
            new Notice("Token saved.");
            this.display();
          }
        });
      });
    new Setting(containerEl).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        const token = this.plugin.getToken();
        if (!s.owner || !s.repo || !token) {
          new Notice("Repository or token missing.");
          return;
        }
        try {
          const result = await this.plugin.inspect(s.owner, s.repo, s.branch, token);
          const kind = result.inspection.kind === "vault" ? "encrypted vault found" : result.inspection.kind === "uninitialized" ? "empty (can be initialised)" : "contains foreign files";
          new Notice(`Connection OK · ${result.canPush ? "write access" : "NO write access"} · ${result.isPrivate ? "private" : "PUBLIC"} · ${kind}`, 8000);
        } catch (error: unknown) {
          new Notice(`Connection failed: ${describeError(error)}`, 8000);
        }
      }),
    );
    const sizeSetting = new Setting(containerEl)
      .setName("Repository size")
      .setDesc(this.plugin.isConfigured() ? "Loading…" : "Not configured")
      .addButton((b) => b.setButtonText("Move to a new repository").setDisabled(!this.plugin.isConfigured()).onClick(() => this.plugin.openMoveVault()));
    if (this.plugin.isConfigured()) {
      void this.plugin
        .repositorySize()
        .then((bytes) =>
          sizeSetting.setDesc(
            `${bytes === null ? "unknown" : formatBytes(bytes)} (as reported by GitHub). Every version stays in the history; moving to a new repository starts over with only the current files and keeps this one as an archive.`,
          ),
        )
        .catch((error: unknown) => sizeSetting.setDesc(`Size unavailable: ${describeError(error)}`));
    }

    // ── Encryption ──
    new Setting(containerEl).setName("Encryption").setHeading();
    const unlocked = this.plugin.keyManager.isUnlocked;
    new Setting(containerEl)
      .setName("Encryption status")
      .setDesc(
        this.plugin.store.state.vaultId
          ? `AES-256-GCM · vault ${this.plugin.store.state.vaultId.slice(0, 8)}… · ${unlocked ? "unlocked" : "locked"}`
          : "No encrypted vault connected",
      )
      .addButton((b) =>
        unlocked
          ? b.setButtonText("Lock").onClick(() => {
              this.plugin.lock();
              this.display();
            })
          : b.setButtonText("Unlock").onClick(async () => {
              if (await this.plugin.promptUnlock()) this.display();
            }),
      );
    new Setting(containerEl)
      .setName("Remember vault key on this device")
      .setDesc("Keeps the vault key in the system keychain so automatic sync works after restarts. Disable to enter the password each session.")
      .addToggle((t) => t.setValue(s.rememberKey).onChange((v) => void this.plugin.setRememberKey(v)));
    this.passwordSection(containerEl, unlocked);
    new Setting(containerEl)
      .setName("Recovery key")
      .setDesc("Create a new recovery key. The previous recovery key stops working.")
      .addButton((b) =>
        b
          .setButtonText("Create new recovery key")
          .setDisabled(!unlocked)
          .onClick(async () => {
            if (!(await confirmDialog(this.app, "Create a new recovery key?", ["The old recovery key will no longer work."], "Create"))) return;
            try {
              await this.plugin.newRecoveryKey();
            } catch (error: unknown) {
              new Notice(describeError(error), 8000);
            }
          }),
      );
    containerEl.createEl("p", {
      cls: "mod-warning",
      text: "If both the vault password and the recovery key are lost, the encrypted data cannot be recovered. There is no hidden recovery function and no server backdoor.",
    });

    // ── Synchronisation ──
    new Setting(containerEl).setName("Synchronization").setHeading();
    new Setting(containerEl).setName("Auto sync").addToggle((t) => t.setValue(s.autoSync).onChange(async (v) => ((s.autoSync = v), await save())));
    new Setting(containerEl).setName("Sync after changes").addToggle((t) => t.setValue(s.syncAfterChanges).onChange(async (v) => ((s.syncAfterChanges = v), await save())));
    new Setting(containerEl)
      .setName("Delay after last change (seconds)")
      .addText((t) =>
        t.setValue(String(s.debounceSeconds)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 5 && n <= 3600) {
            s.debounceSeconds = Math.round(n);
            await save();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Periodic sync in minutes (0 = off, 1–60).")
      .addSlider((sl) =>
        sl
          .setLimits(0, 60, 1)
          .setValue(s.intervalMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => ((s.intervalMinutes = v), await save())),
      );
    new Setting(containerEl).setName("Sync on startup").addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => ((s.syncOnStartup = v), await save())));
    new Setting(containerEl).setName("Sync on app resume").addToggle((t) => t.setValue(s.syncOnResume).onChange(async (v) => ((s.syncOnResume = v), await save())));

    // ── Files ──
    new Setting(containerEl).setName("Files").setHeading();
    new Setting(containerEl).setName(`Sync ${this.app.vault.configDir}`).addToggle((t) => t.setValue(s.syncConfigDir).onChange(async (v) => ((s.syncConfigDir = v), await save(), this.display())));
    if (s.syncConfigDir) {
      const sub = (name: string, desc: string, key: "syncCoreSettings" | "syncPlugins" | "syncThemesAndSnippets" | "syncWorkspace"): void => {
        new Setting(containerEl).setName(name).setDesc(desc).setClass("setting-indent").addToggle((t) => t.setValue(s[key]).onChange(async (v) => ((s[key] = v), await save())));
      };
      sub("Core settings", "app.json, appearance.json, hotkeys.json, core-plugins.json", "syncCoreSettings");
      sub("Community plugins", "Plugin folders and the enabled-plugins list (this plugin is never synced).", "syncPlugins");
      sub("Themes and snippets", "themes/ and snippets/", "syncThemesAndSnippets");
      sub("Workspace layout", "workspace.json – usually device specific", "syncWorkspace");
    }
    new Setting(containerEl)
      .setName("Ignore rules")
      .setDesc(`Edit ${IGNORE_FILE} (gitignore-like syntax, applied before encryption; the file itself is synchronised).`)
      .addTextArea((ta) => {
        ta.inputEl.rows = 6;
        ta.inputEl.addClass("encrypted-sync-ignore-rules");
        void (async (): Promise<void> => {
          const exists = await this.app.vault.adapter.exists(IGNORE_FILE);
          ta.setValue(exists ? await this.app.vault.adapter.read(IGNORE_FILE) : "");
        })();
        ta.inputEl.addEventListener("change", async () => {
          await this.app.vault.adapter.write(IGNORE_FILE, ta.getValue());
          new Notice("Ignore rules saved.");
        });
      });
    new Setting(containerEl)
      .setName("Show sync status in the file explorer")
      .setDesc("● not synchronised yet · ⚠ conflict · ⊘ too large or unreadable · ◌ excluded. Folders show the most important mark of their contents.")
      .addToggle((t) =>
        t.setValue(s.showExplorerStatus).onChange(async (v) => {
          s.showExplorerStatus = v;
          this.plugin.explorerStatus.enabled = v;
          this.plugin.explorerStatus.render();
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Maximum file size (MB)")
      .setDesc(`Larger files are skipped (hard limit ${MAX_FILE_SIZE_MB_LIMIT} MB). Files over 4 MB are uploaded as encrypted chunks; only changed chunks are uploaded again.`)
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= MAX_FILE_SIZE_MB_LIMIT) {
            s.maxFileSizeMB = Math.round(n);
            await save();
          }
        }),
      );

    // ── Version history ──
    new Setting(containerEl).setName("Version history").setHeading();
    new Setting(containerEl)
      .setName("Versions per note")
      .setDesc(
        `How many earlier versions of a Markdown note can be restored (1–${MAX_VERSION_LIMIT}). Versions are read from the encrypted GitHub history (one per sync that changed the note); nothing is stored additionally and older versions are never deleted there.`,
      )
      .addSlider((sl) =>
        sl
          .setLimits(1, MAX_VERSION_LIMIT, 1)
          .setValue(s.versionHistoryLimit)
          .setDynamicTooltip()
          .onChange(async (v) => ((s.versionHistoryLimit = v), await save())),
      );
    new Setting(containerEl)
      .setName("Deleted files")
      .setDesc("Restore files that were deleted on any of your devices.")
      .addButton((b) => b.setButtonText("Show").onClick(() => this.plugin.openDeletedFiles()));

    // ── Diagnostics ──
    new Setting(containerEl).setName("Diagnostics").setHeading();
    for (const [name, value] of statusRows(this.plugin, this.plugin.statusSummary())) {
      this.liveRows.set(name, new Setting(containerEl).setName(name).setDesc(value));
    }
    new Setting(containerEl).setName("Device ID").setDesc(this.plugin.deviceId);
    new Setting(containerEl).setName("Show conflicts").addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.openConflicts()));
    new Setting(containerEl)
      .setName("Sync activity")
      .setDesc("Which files the synchronisations on this device changed (stored locally only).")
      .addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.openActivity()));
    new Setting(containerEl)
      .setName("Verify repository")
      .setDesc("Downloads and decrypts every file on GitHub and checks it against the manifest. Read-only.")
      .addButton((b) => b.setButtonText("Verify").onClick(() => this.plugin.openVerify()));
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Writes technical details to the developer console. Never logs contents, passwords, keys or tokens.")
      .addToggle((t) => t.setValue(s.debugLogging).onChange(async (v) => ((s.debugLogging = v), await save(), this.display())));
    if (s.debugLogging) {
      new Setting(containerEl)
        .setName("Include file paths in debug logs")
        .setDesc("Only enable when asked to for troubleshooting. File names can be sensitive.")
        .addToggle((t) => t.setValue(s.logPaths).onChange(async (v) => ((s.logPaths = v), await save())));
    }

    this.renderLive(this.plugin.statusSummary());
    this.unsubscribe = this.plugin.onStatusChange((status) => this.renderLive(status));
  }

  private passwordSection(containerEl: HTMLElement, unlocked: boolean): void {
    let current = "";
    let next = "";
    let repeat = "";
    const pw = (setting: Setting, set: (v: string) => void, autocomplete: "current-password" | "new-password"): Setting =>
      setting.addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = autocomplete;
        t.onChange(set);
      });
    new Setting(containerEl).setName("Change password").setDesc("Re-encrypts only the vault key; your files are not re-uploaded. Other devices keep working.");
    pw(new Setting(containerEl).setName("Current password").setClass("setting-indent"), (v) => (current = v), "current-password");
    pw(new Setting(containerEl).setName("New password").setClass("setting-indent"), (v) => (next = v), "new-password");
    pw(new Setting(containerEl).setName("Repeat new password").setClass("setting-indent"), (v) => (repeat = v), "new-password").addButton((b) =>
      b
        .setButtonText("Change password")
        .setDisabled(!unlocked)
        .onClick(async () => {
          if (next !== repeat) {
            new Notice("The new passwords do not match.");
            return;
          }
          if ([...next.normalize("NFC")].length < MIN_PASSWORD_LENGTH) {
            new Notice(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
          }
          try {
            await this.plugin.changePassword(current, next);
            current = next = repeat = "";
            new Notice("Vault password changed.");
            this.display();
          } catch (error: unknown) {
            new Notice(describeError(error), 8000);
          }
        }),
    );
  }
}
