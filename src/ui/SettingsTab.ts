import { Notice, Platform, PluginSettingTab, Setting, type App, type ButtonComponent, type ExtraButtonComponent } from "obsidian";
import type { SyncStatus } from "../sync/SyncController";
import { statusRows } from "./StatusModal";
import { describeError } from "../errors/VaultSyncError";
import type EncryptedSyncPlugin from "../main";
import { MAX_FILE_SIZE_MB_LIMIT } from "../settings";
import { MAX_VERSION_LIMIT } from "../sync/VersionHistory";
import { IGNORE_FILE } from "../vault/SyncFilter";
import { confirmDialog, formatBytes, promptSecretText, promptVaultSecret } from "./Modals";
import { DeviceLocalStore } from "../platform/ObsidianStorage";
import { SetupWizard } from "./SetupWizard";
import { describeLocation } from "../remote/BackendLocation";
import { statusText } from "./StatusBar";

const STAGE_KEY = "encrypted-sync-settings-stage";
const STAGE_DONE = "done";

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
  private readonly local = new DeviceLocalStore(this.app);
  private syncStage: string | null = null;
  private readonly openTasks = new Set<string>();
  private stageFile: Promise<void> = Promise.resolve();
  /** Sections the user opened or closed during this session (kept across re-renders). */
  private readonly expanded = new Set<string>();
  private readonly collapsed = new Set<string>();

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

    this.reportPreviousStage(containerEl.createEl("p", { cls: "mod-warning" }));
    this.openTasks.clear();
    this.section("status");

    // ── Status (live) ──
    this.statusSetting = new Setting(containerEl)
      .addButton((b) => {
        this.syncButton = b;
        b.setButtonText("Sync now")
          .setCta()
          .onClick(() => void this.plugin.syncCommand("full"));
      })
      .addButton((b) => b.setButtonText("Details").onClick(() => this.plugin.openStatus()));

    this.group(containerEl, "storage", "Storage", (containerEl) => {
      new Setting(containerEl)
        .setName("Location")
        .setDesc(s.location ? describeLocation(s.location) : "Not configured")
        .addButton((b) => b.setButtonText(this.plugin.isConfigured() ? "Change / reconnect" : "Set up").setCta().onClick(() => new SetupWizard(this.app, this.plugin).open()));
      if (s.location?.kind === "github") {
        const location = s.location;
        const stored = this.plugin.getCredentials() !== null;
        new Setting(containerEl)
          .setName("Access token")
          .setDesc(
            `${stored ? "Stored" : "Not stored"} · ${this.plugin.secrets.persistent ? "kept in the system keychain (never in data.json or the vault)." : "secret storage unavailable: the token is kept in memory only for this session."}`,
          )
          // A dialog instead of an inline password field: iOS can hang on password fields in long settings pages.
          .addButton((b) =>
            b.setButtonText(stored ? "Replace token" : "Enter token").onClick(async () => {
              const token = await promptSecretText(this.app, "GitHub access token", "Fine-grained token with Contents read/write for this repository only.", "github_pat_…");
              if (!token) return;
              this.plugin.setCredentials(location, { kind: "github", token });
              new Notice("Token saved.");
              this.display();
            }),
          );
      }
      new Setting(containerEl).setName("Test connection").addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const location = s.location;
          const credentials = this.plugin.getCredentials();
          if (!location || !credentials) {
            new Notice("Location or credentials missing.");
            return;
          }
          try {
            const result = await this.plugin.inspect(location, credentials);
            if (result.check.access === "missing") {
              new Notice("The location does not exist or the credentials cannot access it.", 8000);
              return;
            }
            const kind = result.inspection.kind === "vault" ? "encrypted vault found" : result.inspection.kind === "uninitialized" ? "empty (can be initialised)" : "contains foreign files";
            const visibility = result.check.isPrivate === null ? "" : result.check.isPrivate ? " · private" : " · PUBLIC";
            new Notice(`Connection OK · ${result.check.writable ? "write access" : "NO write access"}${visibility} · ${kind}`, 8000);
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
        void this.task("repository size", () => this.plugin.repositorySize())
          .then((bytes) =>
            sizeSetting.setDesc(
              `${bytes === null ? "unknown" : formatBytes(bytes)} (as reported by the storage). Every version stays in the history; moving to a new repository starts over with only the current files and keeps this one as an archive.`,
            ),
          )
          .catch((error: unknown) => sizeSetting.setDesc(`Size unavailable: ${describeError(error)}`));
      }
    });

    this.group(containerEl, "encryption", "Encryption", (containerEl) => {
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
      new Setting(containerEl)
        .setName("Change password")
        .setDesc(
          "Re-encrypts only the vault key; your files are not re-uploaded. Other devices keep working. The old password is not revoked: older commits in the repository history still accept it – if it leaked, also move the vault to a new repository and delete the old one.",
        )
        .addButton((b) => b.setButtonText("Change password").setDisabled(!unlocked).onClick(() => this.plugin.openChangePassword()));
      new Setting(containerEl)
        .setName("Recovery key")
        .setDesc("Create a new recovery key (requires the vault password). The new key replaces the old one for the current repository.")
        .addButton((b) =>
          b
            .setButtonText("Create new recovery key")
            .setDisabled(!unlocked)
            .onClick(async () => {
              const ok = await confirmDialog(
                this.app,
                "Create a new recovery key?",
                [
                  "The old recovery key is removed from the current configuration.",
                  "It is NOT revoked: older commits in the repository history still contain it, so anyone with the old key and read access to the repository (or a copy of it) can still decrypt the vault. If the old key was exposed, keep the repository private, move the vault to a new repository afterwards and delete the old repository.",
                ],
                "Continue",
              );
              if (!ok) return;
              const secret = await promptVaultSecret(this.app, "Confirm with your password", "Enter the current vault password to create a new recovery key.", false);
              if (!secret) return;
              try {
                await this.plugin.newRecoveryKey(secret.value);
              } catch (error: unknown) {
                new Notice(describeError(error), 8000);
              }
            }),
        );
      containerEl.createEl("p", {
        cls: "mod-warning",
        text: "If both the vault password and the recovery key are lost, the encrypted data cannot be recovered. There is no hidden recovery function and no server backdoor.",
      });
    });

    this.group(containerEl, "synchronization", "Synchronization", (containerEl) => {
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
    });

    this.group(containerEl, "files", "Files", (containerEl) => {
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
          void this.task("ignore rules", async (): Promise<void> => {
            const exists = await this.app.vault.adapter.exists(IGNORE_FILE);
            ta.setValue(exists ? await this.app.vault.adapter.read(IGNORE_FILE) : "");
          }).catch(() => undefined);
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
    });

    this.group(containerEl, "version history", "Version history", (containerEl) => {
      new Setting(containerEl)
        .setName("Versions per note")
        .setDesc(
          `How many earlier versions of a Markdown note can be restored (1–${MAX_VERSION_LIMIT}). Versions are read from the encrypted history in the storage (one per sync that changed the note); nothing is stored additionally and older versions are never deleted there.`,
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
    });

    this.group(containerEl, "diagnostics", "Diagnostics", (containerEl) => {
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
        .setDesc("Downloads and decrypts every stored file and checks it against the manifest. Read-only.")
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
    });

    this.renderLive(this.plugin.statusSummary());
    this.unsubscribe = this.plugin.onStatusChange((status) => this.renderLive(status));
    this.section(null);
  }

  /**
   * Records which part of the page is being built (device-local, synchronous), so a hang on a device without
   * developer tools can be located: the next opening shows where the previous one stopped.
   */
  private section(name: string | null): void {
    this.syncStage = name;
    this.persistStage();
  }

  /** Tracks background work started by the page (it may finish after rendering). */
  private task<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.openTasks.add(name);
    this.persistStage();
    return work().finally(() => {
      this.openTasks.delete(name);
      this.persistStage();
    });
  }

  private persistStage(): void {
    const value = [this.syncStage, ...this.openTasks].filter(Boolean).join(", ") || STAGE_DONE;
    try {
      this.local.set(STAGE_KEY, value);
    } catch {
      // Diagnostics only.
    }
    // Also in a file: iOS may drop recent local storage writes when a frozen app is killed. Chained, so the
    // previous value is read first and writes land in order.
    const adapter = this.app.vault.adapter;
    const path = this.stagePath();
    this.stageFile = this.stageFile.then(() => adapter.write(path, value)).catch(() => undefined);
  }

  private stagePath(): string {
    const dir = this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return `${dir}/settings-stage.txt`;
  }

  /** Shows where the previous opening stopped, if it did not finish. */
  private reportPreviousStage(warning: HTMLElement): void {
    warning.hide();
    const fromLocal = this.local.get(STAGE_KEY);
    const adapter = this.app.vault.adapter;
    const path = this.stagePath();
    this.stageFile = (async (): Promise<void> => {
      const fromFile = (await adapter.exists(path)) ? (await adapter.read(path)).trim() : null;
      const previous = [fromLocal, fromFile].find((v) => v && v !== STAGE_DONE);
      if (!previous) return;
      warning.show();
      warning.setText(`The last time this page was opened, it did not finish (stopped at: ${previous}). If the app froze, please report this line.`);
    })().catch(() => undefined);
  }

  /**
   * A collapsible section, built on first expansion. Collapsed by default on mobile: the page opens fast, and a
   * problem in one section does not block the others.
   */
  private group(parent: HTMLElement, key: string, title: string, build: (el: HTMLElement) => void): void {
    const heading = new Setting(parent).setName(title).setHeading();
    heading.settingEl.addClass("encrypted-sync-group");
    const body = parent.createDiv();
    let open = this.expanded.has(key) || (!Platform.isMobile && !this.collapsed.has(key));
    let built = false;
    let icon: ExtraButtonComponent | null = null;
    heading.addExtraButton((b) => {
      icon = b;
    });
    const apply = (): void => {
      body.toggle(open);
      icon?.setIcon(open ? "chevron-down" : "chevron-right");
      if (open && !built) {
        built = true;
        this.section(key);
        build(body);
        this.section(null);
      }
    };
    heading.settingEl.addEventListener("click", () => {
      open = !open;
      if (open) {
        this.expanded.add(key);
        this.collapsed.delete(key);
      } else {
        this.expanded.delete(key);
        this.collapsed.add(key);
      }
      apply();
    });
    apply();
  }
}
