import { Modal, Notice, Plugin, Setting, TAbstractFile, TFolder } from "obsidian";
import { WebCryptoProvider } from "./crypto/WebCryptoProvider";
import { KeyManager, MIN_PASSWORD_LENGTH, unlockWithPassword, VaultKeys } from "./crypto/KeyManager";
import { CryptoError } from "./errors/CryptoError";
import { describeError } from "./errors/VaultSyncError";
import { PersonalAccessTokenAuth } from "./github/GitHubAuth";
import { GitHubClient } from "./github/GitHubClient";
import { GitObjectsApi } from "./github/GitObjectsApi";
import { GitHubRemoteRepository } from "./github/GitHubRemoteRepository";
import { ObsidianFileSystem } from "./platform/ObsidianFileSystem";
import { ObsidianHttpClient } from "./platform/ObsidianHttpClient";
import { DeviceLocalStore, ObsidianSecretStore, PluginFolderStore } from "./platform/ObsidianStorage";
import type { RemoteRepository } from "./remote/RemoteRepository";
import { DEFAULT_SETTINGS, loadSettings, type PluginSettings } from "./settings";
import { SecretIds } from "./state/SecretStore";
import { FileStateRepository } from "./state/StateRepository";
import { SyncStateStore } from "./state/SyncStateStore";
import { SyncController, type SyncStatus } from "./sync/SyncController";
import { SyncEngine, type SyncMode, type SyncReport } from "./sync/SyncEngine";
import {
  changeVaultPassword,
  connectExistingVault,
  initializeNewVault,
  inspectRemote,
  rotateRecoveryKey,
  summarizeLocalFiles,
  unlockRemoteVault,
  type RemoteInspection,
  type UnlockSecret,
  type UploadSummary,
} from "./sync/VaultSetup";
import { fromBase64, toBase64, wipe } from "./util/bytes";
import { Logger } from "./util/Logger";
import { IgnoreMatcher } from "./vault/IgnoreMatcher";
import { DEFAULT_IGNORE_RULES, IGNORE_FILE, SyncFilter, type FilterSettings } from "./vault/SyncFilter";
import { ConflictView } from "./ui/ConflictView";
import { SettingsTab } from "./ui/SettingsTab";
import { SetupWizard } from "./ui/SetupWizard";
import { confirmDialog, openChangePasswordModal, promptVaultSecret, showRecoveryKey } from "./ui/Modals";
import { StatusBar, statusText } from "./ui/StatusBar";

const DEVICE_ID_KEY = "encrypted-github-sync-device-id";
const MIB = 1024 * 1024;

export default class EncryptedSyncPlugin extends Plugin {
  override settings: PluginSettings = { ...DEFAULT_SETTINGS };
  readonly crypto = new WebCryptoProvider();
  readonly keyManager = new KeyManager();
  readonly logger = new Logger();
  secrets!: ObsidianSecretStore;
  deviceId!: string;
  store!: SyncStateStore;
  controller!: SyncController;
  fs!: ObsidianFileSystem;
  private statusBar!: StatusBar;
  private lastEngine: SyncEngine | null = null;
  private persistHandle: number | null = null;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.applyLogSettings();
    this.secrets = new ObsidianSecretStore(this.app);
    this.deviceId = this.loadDeviceId();
    const folder = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const repository = new FileStateRepository(new PluginFolderStore(this.app, folder), this.crypto, `state-${this.deviceId}.json`, this.deviceId, () =>
      this.logger.warn("local sync state was invalid and has been ignored"),
    );
    this.store = await SyncStateStore.open(repository, this.deviceId);
    this.fs = new ObsidianFileSystem(this.app, () => (this.settings.syncConfigDir ? [this.app.vault.configDir] : []));

    this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.openStatus());
    this.controller = new SyncController({
      runSync: (mode) => this.runEngine(mode),
      countPending: () => this.buildEngine().countPendingChanges(),
      countConflicts: () => this.store.state.conflicts.length,
      isConfigured: () => this.isConfigured(),
      isUnlocked: () => this.keyManager.isUnlocked,
      settings: () => this.settings,
      timers: {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h),
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (h) => window.clearInterval(h),
        now: () => Date.now(),
      },
      onStatus: (status) => this.statusBar.render(status),
      onReport: (report) => this.reportResult(report, false),
      onError: (error) => this.logger.warn("automatic sync failed", { crypto: error instanceof CryptoError }),
      logger: this.logger,
    });

    this.registerCommands();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      this.registerVaultEvents();
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") this.controller.notifyResume();
      });
      await this.tryAutoUnlock();
      this.controller.start();
    });
  }

  override onunload(): void {
    this.controller?.stop();
    if (this.persistHandle !== null) window.clearTimeout(this.persistHandle);
    if (this.store?.isDirty) void this.store.persist();
    // Only the in-memory copy is dropped; a remembered key stays in the OS keychain.
    this.keyManager.lock();
  }

  // ───────────────────────── configuration ─────────────────────────

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyLogSettings();
    this.controller.rescheduleInterval();
    void this.controller.refreshStatus();
  }

  private applyLogSettings(): void {
    this.logger.level = this.settings.debugLogging ? "debug" : "info";
    this.logger.allowPaths = this.settings.debugLogging && this.settings.logPaths;
  }

  private loadDeviceId(): string {
    const local = new DeviceLocalStore(this.app);
    const existing = local.get(DEVICE_ID_KEY);
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
    const id = globalThis.crypto.randomUUID();
    local.set(DEVICE_ID_KEY, id);
    return id;
  }

  private tokenSecretId(): string {
    return SecretIds.githubToken(`encrypted-github-sync-${this.deviceId}`);
  }

  private masterKeySecretId(vaultId: string): string {
    return SecretIds.masterKey("encrypted-github-sync", vaultId);
  }

  getToken(): string | null {
    return this.secrets.get(this.tokenSecretId());
  }

  setToken(token: string): void {
    if (token) this.secrets.set(this.tokenSecretId(), token.trim());
    else this.secrets.delete(this.tokenSecretId());
  }

  isConfigured(): boolean {
    return !!(this.settings.owner && this.settings.repo && this.getToken() && this.store.state.vaultId);
  }

  filterSettings(): FilterSettings {
    return {
      configDir: this.app.vault.configDir,
      pluginId: this.manifest.id,
      syncConfigDir: this.settings.syncConfigDir,
      syncCoreSettings: this.settings.syncCoreSettings,
      syncPlugins: this.settings.syncPlugins,
      syncThemesAndSnippets: this.settings.syncThemesAndSnippets,
      syncWorkspace: this.settings.syncWorkspace,
    };
  }

  async buildFilter(): Promise<SyncFilter> {
    const rules = [...DEFAULT_IGNORE_RULES];
    if (await this.app.vault.adapter.exists(IGNORE_FILE)) rules.push(...(await this.app.vault.adapter.read(IGNORE_FILE)).split(/\r?\n/));
    return new SyncFilter(this.filterSettings(), new IgnoreMatcher(rules));
  }

  buildApi(owner = this.settings.owner, repo = this.settings.repo, token: string | null = this.getToken()): GitObjectsApi {
    const client = new GitHubClient({
      http: new ObsidianHttpClient(),
      auth: new PersonalAccessTokenAuth(() => token),
      logger: this.logger,
    });
    return new GitObjectsApi(client, owner, repo);
  }

  buildRemote(owner = this.settings.owner, repo = this.settings.repo, branch = this.settings.branch, token: string | null = this.getToken()): RemoteRepository {
    return new GitHubRemoteRepository(this.buildApi(owner, repo, token), { branch });
  }

  private buildEngine(): SyncEngine {
    const engine = new SyncEngine({
      crypto: this.crypto,
      fs: this.fs,
      remote: this.buildRemote(),
      store: this.store,
      getKeys: () => this.keyManager.keys,
      filterSettings: this.filterSettings(),
      limits: { maxFileSize: this.settings.maxFileSizeMB * MIB },
      deviceId: this.deviceId,
      logger: this.logger,
    });
    this.lastEngine = engine;
    return engine;
  }

  private runEngine(mode: SyncMode): Promise<SyncReport> {
    return this.buildEngine().sync(mode);
  }

  // ───────────────────────── keys ─────────────────────────

  private async tryAutoUnlock(): Promise<void> {
    const vaultId = this.store.state.vaultId;
    if (!vaultId || !this.settings.rememberKey || this.keyManager.isUnlocked) return;
    const stored = this.secrets.get(this.masterKeySecretId(vaultId));
    if (!stored) return;
    let mk: Uint8Array | null = null;
    try {
      mk = fromBase64(stored);
      // The config MAC is verified against this key on every remote change (SyncEngine.loadRemote).
      this.keyManager.setKeys(await VaultKeys.fromMasterKey(this.crypto, vaultId, mk));
    } catch (error: unknown) {
      this.logger.warn("remembered key could not be loaded", { crypto: error instanceof CryptoError });
    } finally {
      wipe(mk);
    }
  }

  private rememberKeys(keys: VaultKeys): void {
    const id = this.masterKeySecretId(keys.vaultId);
    if (!this.settings.rememberKey || !this.secrets.persistent) {
      this.secrets.delete(id);
      return;
    }
    const mk = keys.exportMasterKey();
    try {
      this.secrets.set(id, toBase64(mk));
    } finally {
      wipe(mk);
    }
  }

  async setRememberKey(remember: boolean): Promise<void> {
    this.settings.rememberKey = remember;
    await this.saveSettings();
    if (this.keyManager.isUnlocked) this.rememberKeys(this.keyManager.keys);
    else if (!remember && this.store.state.vaultId) this.secrets.delete(this.masterKeySecretId(this.store.state.vaultId));
  }

  async unlock(secret: UnlockSecret): Promise<void> {
    const inspection = await inspectRemote(this.buildRemote());
    if (inspection.kind !== "vault") throw new CryptoError("InvalidInput", "repository contains no encrypted vault");
    if (inspection.config.vaultId !== this.store.state.vaultId) throw new CryptoError("ConfigIntegrity");
    const keys = await unlockRemoteVault(this.crypto, inspection.config, secret);
    this.keyManager.setKeys(keys);
    this.rememberKeys(keys);
    this.controller.clearBlock();
    await this.controller.refreshStatus();
  }

  lock(): void {
    const vaultId = this.store.state.vaultId;
    this.keyManager.lock();
    if (vaultId) this.secrets.delete(this.masterKeySecretId(vaultId));
    void this.controller.refreshStatus();
    new Notice("Encrypted sync locked. The vault password is required for the next sync.");
  }

  // ───────────────────────── setup flows ─────────────────────────

  async inspect(owner: string, repo: string, branch: string, token: string): Promise<{ inspection: RemoteInspection; canPush: boolean; isPrivate: boolean }> {
    const api = this.buildApi(owner, repo, token);
    const info = await api.getRepository();
    const inspection = await inspectRemote(new GitHubRemoteRepository(api, { branch }));
    return { inspection, canPush: info.canPush, isPrivate: info.isPrivate };
  }

  async localSummary(): Promise<UploadSummary> {
    return summarizeLocalFiles(this.fs, await this.buildFilter(), this.settings.maxFileSizeMB * MIB);
  }

  async createNewVault(password: string): Promise<string | null> {
    const result = await initializeNewVault({
      crypto: this.crypto,
      remote: this.buildRemote(),
      store: this.store,
      password,
      deviceId: this.deviceId,
      withRecoveryKey: true,
      kdf: this.settings.kdfForNewVaults,
    });
    this.keyManager.setKeys(result.keys);
    this.rememberKeys(result.keys);
    return result.recoveryKey;
  }

  async connectVault(secret: UnlockSecret): Promise<void> {
    const result = await connectExistingVault({ crypto: this.crypto, remote: this.buildRemote(), store: this.store, secret, deviceId: this.deviceId });
    this.keyManager.setKeys(result.keys);
    this.rememberKeys(result.keys);
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const keys = this.keyManager.keys;
    const inspection = await inspectRemote(this.buildRemote());
    if (inspection.kind !== "vault") throw new CryptoError("InvalidInput", "repository contains no encrypted vault");
    // Verify the current password (old password → master key) before re-wrapping.
    const check = await unlockWithPassword(this.crypto, inspection.config, currentPassword);
    check.destroy();
    await this.controller.runExclusive(() => changeVaultPassword({ crypto: this.crypto, remote: this.buildRemote(), keys, deviceId: this.deviceId, newPassword }));
  }

  async newRecoveryKey(): Promise<void> {
    const keys = this.keyManager.keys;
    const key = await this.controller.runExclusive(() => rotateRecoveryKey({ crypto: this.crypto, remote: this.buildRemote(), keys, deviceId: this.deviceId }));
    await showRecoveryKey(this.app, key);
  }

  async dismissConflict(id: string): Promise<void> {
    this.store.state.conflicts = this.store.state.conflicts.filter((c) => c.id !== id);
    await this.store.persist();
    await this.controller.refreshStatus();
  }

  // ───────────────────────── commands / events ─────────────────────────

  async syncCommand(mode: SyncMode): Promise<void> {
    if (!this.isConfigured()) {
      new SetupWizard(this.app, this).open();
      return;
    }
    if (!this.keyManager.isUnlocked && !(await this.promptUnlock())) return;
    this.controller.clearBlock();
    try {
      const report = await this.controller.runNow(mode);
      if (report) this.reportResult(report, true);
      else new Notice("A synchronisation is already running; it will run again when finished.");
    } catch (error: unknown) {
      new Notice(`Encrypted sync: ${describeError(error)}`, 10000);
    }
  }

  async promptUnlock(): Promise<boolean> {
    const secret = await promptVaultSecret(this.app, "Unlock encrypted vault", "Enter the vault password to allow synchronisation.");
    if (!secret) return false;
    try {
      await this.unlock(secret.kind === "password" ? { password: secret.value } : { recoveryKey: secret.value });
      return true;
    } catch (error: unknown) {
      new Notice(describeError(error), 8000);
      return false;
    }
  }

  private reportResult(report: SyncReport, manual: boolean): void {
    const conflicts = report.newConflicts.length;
    if (conflicts > 0) new Notice(`${conflicts} synchronization conflict${conflicts === 1 ? "" : "s"} detected.`, 10000);
    if (report.nameCollisions.length > 0) new Notice(`${report.nameCollisions.length} file(s) not uploaded: another file with the same name (different case) exists.`, 10000);
    if (report.failedLocalOps > 0) new Notice(`${report.failedLocalOps} local change(s) could not be applied and will be retried.`, 8000);
    if (manual && conflicts === 0) {
      const parts = [`↓ ${report.downloaded}`, `↑ ${report.uploaded}`];
      if (report.localDeletes + report.remoteDeletes > 0) parts.push(`🗑 ${report.localDeletes + report.remoteDeletes}`);
      new Notice(`Encrypted sync complete (${parts.join(", ")})${report.morePending ? " – continuing in the background" : ""}.`);
    }
  }

  private registerCommands(): void {
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncCommand("full") });
    this.addCommand({ id: "pull", name: "Pull from GitHub", callback: () => void this.syncCommand("pull") });
    // Pushing always pulls and merges first (never a blind or forced push).
    this.addCommand({ id: "push", name: "Push to GitHub", callback: () => void this.syncCommand("full") });
    this.addCommand({ id: "show-status", name: "Show status", callback: () => this.openStatus() });
    this.addCommand({ id: "show-conflicts", name: "Show conflicts", callback: () => this.openConflicts() });
    this.addCommand({ id: "lock", name: "Lock vault", callback: () => this.lock() });
    this.addCommand({ id: "unlock", name: "Unlock vault", callback: () => void this.promptUnlock() });
    this.addCommand({ id: "change-password", name: "Change password", callback: () => this.openChangePassword() });
    this.addCommand({ id: "setup", name: "Set up / connect repository", callback: () => new SetupWizard(this.app, this).open() });
  }

  private openChangePassword(): void {
    if (!this.keyManager.isUnlocked) {
      new Notice("Unlock the vault first.");
      return;
    }
    openChangePasswordModal(this.app, MIN_PASSWORD_LENGTH, (current, next) => this.changePassword(current, next));
  }

  openConflicts(): void {
    new ConflictView(this.app, { list: () => this.store.state.conflicts, dismiss: (id) => this.dismissConflict(id) }).open();
  }

  private openStatus(): void {
    new StatusModal(this).open();
  }

  private registerVaultEvents(): void {
    const changed = (): void => this.controller.notifyChange();
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.vault.on("delete", changed));
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Keep stable object ids across renames/moves (files and whole folders).
        if (this.store.recordRename(oldPath, file.path) || file instanceof TFolder) this.schedulePersist();
        changed();
      }),
    );
  }

  private schedulePersist(): void {
    if (this.persistHandle !== null) window.clearTimeout(this.persistHandle);
    this.persistHandle = window.setTimeout(() => {
      this.persistHandle = null;
      if (!this.controller.isSyncing) void this.store.persist();
      else this.schedulePersist();
    }, 2000);
  }

  statusSummary(): SyncStatus {
    return this.controller.current;
  }

  /** Whether the remote config seen by the last sync has a recovery key slot. */
  hasRecoverySlot(): boolean | null {
    const config = this.lastEngine?.lastConfig;
    return config ? config.keySlots.some((s) => s.type === "recovery") : null;
  }
}

class StatusModal extends Modal {
  constructor(private readonly plugin: EncryptedSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    const status = this.plugin.statusSummary();
    const state = this.plugin.store.state;
    this.titleEl.setText("Encrypted sync status");
    const rows: Array<[string, string]> = [
      ["Status", statusText(status)],
      ["Details", status.message ?? "–"],
      ["Pending local changes", String(status.pending)],
      ["Conflicts", String(state.conflicts.length)],
      ["Last sync", state.lastSyncTime ? new Date(state.lastSyncTime).toLocaleString() : "never"],
      ["Last remote commit", state.lastRemoteCommit ? state.lastRemoteCommit.slice(0, 12) : "–"],
      ["Manifest version", String(state.lastManifestVersion)],
      ["Vault key", this.plugin.keyManager.isUnlocked ? "unlocked" : "locked"],
    ];
    for (const [name, value] of rows) new Setting(this.contentEl).setName(name).setDesc(value);
    const actions = new Setting(this.contentEl);
    actions.addButton((b) =>
      b
        .setButtonText("Sync now")
        .setCta()
        .onClick(() => {
          this.close();
          void this.plugin.syncCommand("full");
        }),
    );
    if (state.conflicts.length > 0) {
      actions.addButton((b) =>
        b.setButtonText("Show conflicts").onClick(() => {
          this.close();
          this.plugin.openConflicts();
        }),
      );
    }
    if (status.state === "blocked") {
      this.contentEl.createEl("p", {
        cls: "mod-warning",
        text: "Synchronisation was stopped to protect your local files. Check the repository on GitHub before continuing.",
      });
      actions.addButton((b) =>
        b
          .setButtonText("Retry")
          .setWarning()
          .onClick(async () => {
            if (!(await confirmDialog(this.app, "Retry synchronisation?", ["Only continue if you understand why the repository changed."], "Retry", true))) return;
            this.close();
            void this.plugin.syncCommand("full");
          }),
      );
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
