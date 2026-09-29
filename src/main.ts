import { Notice, Plugin, setIcon, TAbstractFile, TFile } from "obsidian";
import { WebCryptoProvider } from "./crypto/WebCryptoProvider";
import { KeyManager, MIN_PASSWORD_LENGTH, unlockWithPassword, VaultKeys } from "./crypto/KeyManager";
import { CryptoError } from "./errors/CryptoError";
import { describeError, logUnexpected } from "./errors/VaultSyncError";
import { RemoteError } from "./errors/RemoteError";
import { gitHubBackend } from "./github/GitHubBackend";
import { assertMatching, backendFor, registerBackend, type BackendCheck, type BackendDeps } from "./remote/Backend";
import { describeLocation, sameLocation, toLocation, type BackendLocation } from "./remote/BackendLocation";
import { credentialSecretId, credentialSecrets, parseCredentials, serializeCredentials, type Credentials } from "./remote/Credentials";
import { ObsidianFileSystem } from "./platform/ObsidianFileSystem";
import { ObsidianHttpClient } from "./platform/ObsidianHttpClient";
import { DeviceLocalStore, ObsidianSecretStore, PluginFolderStore } from "./platform/ObsidianStorage";
import type { RemoteRepository } from "./remote/RemoteRepository";
import { DEFAULT_SETTINGS, loadSettings, type PluginSettings } from "./settings";
import { SecretIds } from "./state/SecretStore";
import { FileStateRepository } from "./state/StateRepository";
import { SyncStateStore } from "./state/SyncStateStore";
import { ActivityLog } from "./state/ActivityLog";
import type { ConflictRecord } from "./state/LocalState";
import { SyncController, type SyncStatus } from "./sync/SyncController";
import { SyncEngine, type FileChange, type SyncMode, type SyncReport } from "./sync/SyncEngine";
import { ConflictResolver } from "./sync/ConflictResolver";
import { DeletedFiles, type ResolvedDeletedFile } from "./sync/DeletedFiles";
import { RepositoryVerifier, type VerifyReport } from "./sync/RepositoryVerifier";
import { VersionHistory, type FileVersion, type HistorySource, type RestoreOutcome } from "./sync/VersionHistory";
import { completeSwitch, followMove, moveVault } from "./sync/VaultMigration";
import { DEFAULT_CHUNK_SIZE } from "./sync/ChunkedContent";
import type { PublicVaultConfig } from "./manifest/VaultConfig";
import { SyncError } from "./errors/SyncError";
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
import { formatBytes, openChangePasswordModal, promptVaultSecret, showRecoveryKey } from "./ui/Modals";
import { StatusModal } from "./ui/StatusModal";
import { StatusBar, statusText } from "./ui/StatusBar";
import { VersionHistoryModal } from "./ui/VersionHistoryModal";
import { ActivityModal } from "./ui/ActivityModal";
import { DeletedFilesModal } from "./ui/DeletedFilesModal";
import { VerifyModal } from "./ui/VerifyModal";
import { MoveVaultModal } from "./ui/MoveVaultModal";
import { ExplorerStatus } from "./ui/ExplorerStatus";

registerBackend(gitHubBackend);

const DEVICE_ID_KEY = "encrypted-github-sync-device-id";
const MIB = 1024 * 1024;
/** Suggest moving to a fresh repository above this size (GitHub recommends staying well below 5 GB). */
const SIZE_WARNING_BYTES = 1024 * MIB;

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
  private ribbonEl: HTMLElement | null = null;
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  private lastEngine: SyncEngine | null = null;
  activity!: ActivityLog;
  private sizeCache: { at: number; bytes: number | null } | null = null;
  private sizeWarned = false;
  private unloading = false;
  /** Latest verified public config (for the settings UI). */
  private knownConfig: PublicVaultConfig | null = null;
  explorerStatus!: ExplorerStatus;
  private persistHandle: number | null = null;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.applyLogSettings();
    this.secrets = new ObsidianSecretStore(this.app);
    this.deviceId = this.loadDeviceId();
    const folder = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const repository = new FileStateRepository(new PluginFolderStore(this.app, folder), this.crypto, `state-${this.deviceId}.json`, this.deviceId, (reason) => {
      this.logger.warn("local sync state problem");
      new Notice(`Encrypted sync: ${reason}.`, 15000);
    });
    this.store = await SyncStateStore.open(repository, this.deviceId);
    this.activity = new ActivityLog(new PluginFolderStore(this.app, folder), `activity-${this.deviceId}.json`);
    await this.activity.load();
    this.fs = new ObsidianFileSystem(this.app, () => (this.settings.syncConfigDir ? [this.app.vault.configDir] : []));

    this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.openStatus());
    this.explorerStatus = new ExplorerStatus(this.app, () => this.store.state.conflicts);
    this.explorerStatus.enabled = this.settings.showExplorerStatus;
    // Obsidian mobile has no status bar: the ribbon icon shows the state and opens the status dialog.
    this.ribbonEl = this.addRibbonIcon("cloud", "Encrypted sync", () => this.openStatus());
    this.controller = new SyncController({
      runSync: (mode) => this.runEngine(mode),
      countPending: async () => {
        const status = await this.buildEngine().localStatus();
        this.explorerStatus.update(status.files);
        return status.pending;
      },
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
      onStatus: (status) => this.publishStatus(status),
      onReport: (report) => this.reportResult(report, false),
      onError: (error) => {
        this.logger.warn("automatic sync failed", { crypto: error instanceof CryptoError });
        this.logError(error);
      },
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
      // A vault move interrupted before its settings switch completes here.
      await this.finishPendingSwitch().catch((error: unknown) => logUnexpected(this.settings.debugLogging, "finish repository switch", error));
      this.controller.start();
    });
  }

  override onunload(): void {
    // A running sync stops at its next safe point instead of writing on behind a newly loaded instance.
    this.unloading = true;
    this.controller?.stop();
    this.explorerStatus?.destroy();
    if (this.persistHandle !== null) window.clearTimeout(this.persistHandle);
    if (this.store?.isDirty) this.store.persist().catch(() => undefined);
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

  private masterKeySecretId(vaultId: string): string {
    return SecretIds.masterKey(vaultId);
  }

  /** Credentials for a location (default: the configured one) from the keychain, or null. */
  getCredentials(location: BackendLocation | null = this.settings.location): Credentials | null {
    if (!location) return null;
    // Status updates and the settings page ask often; the platform keychain is read once per location.
    const id = credentialSecretId(location);
    if (this.credentialCache.has(id)) return this.credentialCache.get(id) ?? null;
    const credentials = this.readCredentials(location, id);
    this.credentialCache.set(id, credentials);
    return credentials;
  }

  private readonly credentialCache = new Map<string, Credentials | null>();

  private readCredentials(location: BackendLocation, id: string): Credentials | null {
    const raw = this.secrets.get(id);
    if (raw) {
      try {
        return parseCredentials(raw, location.kind);
      } catch {
        return null;
      }
    }
    // 0.4 and earlier kept one GitHub token per device.
    if (location.kind === "github") {
      const legacy = this.secrets.get(SecretIds.githubToken(this.deviceId));
      if (legacy) return { kind: "github", token: legacy };
    }
    return null;
  }

  setCredentials(location: BackendLocation, credentials: Credentials | null): void {
    this.credentialCache.delete(credentialSecretId(location));
    if (credentials) {
      assertMatching(location, credentials);
      this.secrets.set(credentialSecretId(location), serializeCredentials(credentials));
    } else {
      this.secrets.delete(credentialSecretId(location));
    }
  }

  /** Every secret that must never appear in any message (for redaction). */
  private tokenList(): string[] {
    return credentialSecrets(this.getCredentials());
  }

  isConfigured(): boolean {
    return !!(this.settings.location && this.getCredentials() && this.store.state.vaultId);
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

  backendDeps(): BackendDeps {
    return { http: new ObsidianHttpClient(), crypto: this.crypto, logger: this.logger };
  }

  /** The remote for a location (default: the configured one) with its stored or the given credentials. */
  buildRemote(location: BackendLocation | null = this.settings.location, credentials: Credentials | null = this.getCredentials(location)): RemoteRepository {
    if (!location) throw new SyncError("NotConfigured");
    if (!credentials) throw new RemoteError("Authentication");
    assertMatching(location, credentials);
    return backendFor(location.kind).build(location as never, credentials as never, this.backendDeps());
  }

  /** Access check of a location (exists, writable, private). */
  checkLocation(location: BackendLocation, credentials: Credentials): Promise<BackendCheck> {
    assertMatching(location, credentials);
    return backendFor(location.kind).check(location as never, credentials as never, this.backendDeps());
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
      shouldStop: () => this.unloading,
      deviceId: this.deviceId,
      logger: this.logger,
    });
    this.lastEngine = engine;
    return engine;
  }

  private async runEngine(mode: SyncMode): Promise<SyncReport> {
    // Runs under the sync mutex: a repository switch interrupted earlier is completed before anything else.
    await this.finishPendingSwitch();
    const engine = this.buildEngine();
    try {
      return await engine.sync(mode);
    } finally {
      if (engine.lastConfig) this.knownConfig = engine.lastConfig;
    }
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
    const removed = vaultId ? this.forgetMasterKey(vaultId) : true;
    void this.controller.refreshStatus();
    if (removed) new Notice("Encrypted sync locked. The vault password is required for the next sync.");
    else {
      // The keychain refused the delete: make sure the key is at least never used automatically again.
      this.settings.rememberKey = false;
      void this.saveSettings();
      new Notice("Locked for this session, but the remembered vault key could not be removed from the system keychain. Automatic unlocking was turned off; remove the entry manually if needed.", 15000);
    }
  }

  /** Deletes a remembered master key and reports whether it is really gone. */
  private forgetMasterKey(vaultId: string): boolean {
    const id = this.masterKeySecretId(vaultId);
    this.secrets.delete(id);
    return this.secrets.get(id) === null;
  }

  /** Before switching this device to another vault: the previous vault's remembered key must not stay behind. */
  private forgetPreviousVaultKey(nextVaultId: string | null): void {
    const previous = this.store.state.vaultId;
    if (previous && previous !== nextVaultId) this.forgetMasterKey(previous);
  }

  // ───────────────────────── setup flows ─────────────────────────

  async inspect(location: BackendLocation, credentials: Credentials): Promise<{ inspection: RemoteInspection; check: BackendCheck }> {
    const check = await this.checkLocation(location, credentials);
    const inspection: RemoteInspection = check.access === "ok" ? await inspectRemote(this.buildRemote(location, credentials)) : { kind: "uninitialized" };
    return { inspection, check };
  }

  async localSummary(): Promise<UploadSummary> {
    return summarizeLocalFiles(this.fs, await this.buildFilter(), this.settings.maxFileSizeMB * MIB);
  }

  async createNewVault(password: string): Promise<string | null> {
    this.forgetPreviousVaultKey(null);
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
    const previous = this.store.state.vaultId;
    const result = await connectExistingVault({ crypto: this.crypto, remote: this.buildRemote(), store: this.store, secret, deviceId: this.deviceId });
    if (previous && previous !== result.keys.vaultId) this.forgetMasterKey(previous);
    this.keyManager.setKeys(result.keys);
    this.rememberKeys(result.keys);
  }

  /** Verifies the vault password against the current remote config (old password → master key). */
  private async verifyPassword(password: string): Promise<void> {
    const inspection = await inspectRemote(this.buildRemote());
    if (inspection.kind !== "vault") throw new CryptoError("InvalidInput", "repository contains no encrypted vault");
    const check = await unlockWithPassword(this.crypto, inspection.config, password);
    check.destroy();
  }

  /**
   * Runs a config change (password, recovery key) directly after a successful sync, so it is built on the
   * verified local state; retried if another device pushed in between.
   */
  private async configChange<T>(change: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (!(await this.controller.runNow("full"))) throw new SyncError("InvalidState", "synchronisation is not possible right now (locked, blocked or already running)");
      try {
        return await this.controller.runExclusive(change);
      } catch (error: unknown) {
        if (!(error instanceof SyncError) || error.code !== "ConcurrentRemoteUpdate" || attempt >= 2) throw error;
      }
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const keys = this.keyManager.keys;
    await this.verifyPassword(currentPassword);
    this.knownConfig = await this.configChange(() => changeVaultPassword({ crypto: this.crypto, remote: this.buildRemote(), store: this.store, keys, deviceId: this.deviceId, newPassword }));
  }

  /** A new recovery key is a long-term credential: only with the current password. */
  async newRecoveryKey(currentPassword: string): Promise<void> {
    const keys = this.keyManager.keys;
    await this.verifyPassword(currentPassword);
    const result = await this.configChange(() => rotateRecoveryKey({ crypto: this.crypto, remote: this.buildRemote(), store: this.store, keys, deviceId: this.deviceId }));
    this.knownConfig = result.config;
    await showRecoveryKey(this.app, result.recoveryKey);
  }

  // ───────────────────────── version history ─────────────────────────

  versionHistory(): VersionHistory {
    return new VersionHistory({ crypto: this.crypto, fs: this.fs, remote: this.buildRemote(), store: this.store, getKeys: () => this.keyManager.keys, archives: this.archiveSources() });
  }

  async openVersionHistory(file: TFile): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Encrypted sync is not set up yet.");
      return;
    }
    if (!this.keyManager.isUnlocked && !(await this.promptUnlock())) return;
    new VersionHistoryModal(this, file.path).open();
  }

  /** Replaces a note's content with an earlier version without ever losing the current content. */
  async restoreVersion(path: string, version: FileVersion, content: Uint8Array): Promise<RestoreOutcome> {
    const history = this.versionHistory();
    // Unsynced current content is pushed first so it becomes a version itself; if that does not happen
    // (offline, blocked, conflict), restore() refuses and the user can restore as a copy instead.
    if (!(await history.isCurrentContentSynced(path, version.objectId))) await this.controller.runNow("full");
    const outcome = await this.controller.runExclusive(() => history.restore(path, version, content));
    if (outcome === "restored") await this.logAction(`Version from ${new Date(version.date).toLocaleString()} restored`, [{ action: "restored", path }]);
    this.controller.notifyChange();
    return outcome;
  }

  async restoreVersionAsCopy(path: string, version: FileVersion, content: Uint8Array): Promise<string> {
    const history = this.versionHistory();
    const copy = await this.controller.runExclusive(() => history.restoreAsCopy(path, version, content));
    await this.logAction(`Version from ${new Date(version.date).toLocaleString()} restored as copy`, [{ action: "restored", path: copy, other: path }]);
    this.controller.notifyChange();
    return copy;
  }

  // ───────────────────────── deleted files / verification / activity ─────────────────────────

  deletedFiles(): DeletedFiles {
    return new DeletedFiles({ crypto: this.crypto, fs: this.fs, remote: this.buildRemote(), store: this.store, getKeys: () => this.keyManager.keys, archives: this.archiveSources() });
  }

  async restoreDeletedFile(deleted: DeletedFiles, file: ResolvedDeletedFile): Promise<string> {
    const content = await deleted.load(file);
    const path = await this.controller.runExclusive(() => deleted.restore(file, content));
    await this.logAction("Deleted file restored", [{ action: "restored", path, ...(path !== file.path ? { other: file.path } : {}) }]);
    this.controller.notifyChange();
    return path;
  }

  verifyRepository(onProgress: (done: number, total: number) => void, isCancelled: () => boolean): Promise<VerifyReport> {
    return new RepositoryVerifier({ crypto: this.crypto, remote: this.buildRemote(), store: this.store, getKeys: () => this.keyManager.keys, onProgress, isCancelled }).verify();
  }

  /** Opens a dialog that needs the configured and unlocked vault. */
  private async openUnlocked(open: () => void): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Encrypted sync is not set up yet.");
      return;
    }
    if (!this.keyManager.isUnlocked && !(await this.promptUnlock())) return;
    open();
  }

  openDeletedFiles(): void {
    void this.openUnlocked(() => new DeletedFilesModal(this).open());
  }

  openVerify(): void {
    void this.openUnlocked(() => new VerifyModal(this).open());
  }

  openActivity(): void {
    new ActivityModal(this).open();
  }

  private async logAction(summary: string, changes: FileChange[]): Promise<void> {
    try {
      await this.activity.add("action", summary, changes);
    } catch (error: unknown) {
      logUnexpected(this.settings.debugLogging, "activity log", error);
    }
  }

  private logSync(report: SyncReport): void {
    const failed = report.failedLocalOps > 0 ? `, ${report.failedLocalOps} change(s) postponed` : "";
    if (report.changes.length === 0 && !failed) return;
    const parts = [`↓ ${report.downloaded}`, `↑ ${report.uploaded}`];
    if (report.localDeletes + report.remoteDeletes > 0) parts.push(`🗑 ${report.localDeletes + report.remoteDeletes}`);
    if (report.newConflicts.length > 0) parts.push(`⚠ ${report.newConflicts.length} conflict(s)`);
    this.activity.add("sync", `${parts.join(", ")}${failed}`, report.changes).catch((error: unknown) => logUnexpected(this.settings.debugLogging, "activity log", error));
  }

  private logError(error: unknown): void {
    this.activity.add("error", `Sync failed: ${describeError(error, this.tokenList())}`).catch((e: unknown) => logUnexpected(this.settings.debugLogging, "activity log", e));
  }

  // ───────────────────────── repository size / moving the vault ─────────────────────────

  currentLocation(): BackendLocation {
    if (!this.settings.location) throw new SyncError("NotConfigured");
    return this.settings.location;
  }

  /**
   * Credentials for another location: stored ones, or – for the same backend kind – the current ones (a
   * GitHub token usually covers the new repository too). Stored for that location once used.
   */
  private credentialsFor(location: BackendLocation): Credentials | null {
    const stored = this.getCredentials(location);
    if (stored) return stored;
    const current = this.getCredentials();
    return current && current.kind === location.kind ? current : null;
  }

  /** Earlier locations of a moved vault (read-only history sources; archives without credentials are skipped). */
  private archiveSources(): HistorySource[] {
    const sources: HistorySource[] = [];
    for (const archive of this.store.state.remote?.movedFrom ?? []) {
      const location = toLocation(archive);
      const credentials = this.credentialsFor(location);
      if (credentials) sources.push({ remote: this.buildRemote(location, credentials), from: archive.commit });
    }
    return sources;
  }

  /** Storage size as reported by the backend (cached for 10 minutes; GitHub itself updates it lazily). */
  async repositorySize(force = false): Promise<number | null> {
    const now = Date.now();
    if (!force && this.sizeCache && now - this.sizeCache.at < 10 * 60_000) return this.sizeCache.bytes;
    const location = this.currentLocation();
    const credentials = this.getCredentials(location);
    const size = backendFor(location.kind).size;
    const bytes = size && credentials ? await size(location as never, credentials as never, this.backendDeps()) : null;
    this.sizeCache = { at: now, bytes };
    return bytes;
  }

  private async warnAboutSize(): Promise<void> {
    if (this.sizeWarned || !this.isConfigured()) return;
    const bytes = await this.repositorySize().catch(() => null);
    if (bytes === null || bytes < SIZE_WARNING_BYTES) return;
    this.sizeWarned = true;
    new Notice(`The storage is ${formatBytes(bytes)} large. Every version stays in its history; you can continue in a fresh location (settings → Move to a new repository).`, 15000);
  }

  /** What a target location for a move currently is. */
  async inspectMoveTarget(target: BackendLocation): Promise<{ state: "missing" | "empty" | "resumable" | "foreign" | "otherVault"; isPrivate: boolean }> {
    const credentials = this.credentialsFor(target);
    if (!credentials) throw new RemoteError("Authentication");
    const check = await this.checkLocation(target, credentials);
    if (check.access === "missing") return { state: "missing", isPrivate: false };
    const inspection = await inspectRemote(this.buildRemote(target, credentials));
    const state = inspection.kind === "uninitialized" ? "empty" : inspection.kind === "foreign" ? "foreign" : inspection.config.vaultId === this.store.state.vaultId ? "resumable" : "otherVault";
    // A backend without a public/private notion is as private as its access control.
    return { state, isPrivate: check.isPrivate ?? true };
  }

  canCreateMoveTarget(target: BackendLocation): boolean {
    return backendFor(target.kind).create !== undefined;
  }

  async createMoveTarget(target: BackendLocation): Promise<void> {
    const credentials = this.credentialsFor(target);
    const create = backendFor(target.kind).create;
    if (!credentials || !create) throw new RemoteError("Unsupported");
    await create(target as never, credentials as never, this.backendDeps());
  }

  /** Syncs, copies the vault into `target`, retires the current location and switches this device over. */
  async moveToRepository(target: BackendLocation, onProgress: (done: number, total: number) => void): Promise<number> {
    const credentials = this.credentialsFor(target);
    if (!credentials) throw new RemoteError("Authentication");
    const report = await this.controller.runNow("full");
    if (!report) throw new SyncError("InvalidState", "synchronisation is not possible right now (locked, blocked or already running)");
    const source = this.currentLocation();
    this.setCredentials(target, credentials);
    const result = await this.controller.runExclusive(() =>
      moveVault({
        crypto: this.crypto,
        keys: this.keyManager.keys,
        store: this.store,
        deviceId: this.deviceId,
        source: this.buildRemote(),
        sourceLocation: source,
        target: this.buildRemote(target, credentials),
        targetLocation: target,
        limits: { chunkSize: DEFAULT_CHUNK_SIZE },
        onProgress,
      }),
    );
    await this.finishPendingSwitch();
    await this.logAction(`Vault moved from ${describeLocation(source)} to ${describeLocation(target)} (${result.copied} files copied)`, []);
    void this.controller.requestSync("full");
    return result.copied;
  }

  /** After another device moved the vault: continue in the location its marker names (following chains). */
  async followVaultMove(): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
      const moved = this.store.state.movedTo;
      if (!moved) break;
      const target = toLocation(moved);
      const credentials = this.credentialsFor(target);
      if (!credentials) throw new RemoteError("Authentication");
      const source = this.currentLocation();
      await this.controller.runExclusive(() =>
        followMove({ crypto: this.crypto, keys: this.keyManager.keys, store: this.store, deviceId: this.deviceId, sourceLocation: source, target: this.buildRemote(target, credentials) }),
      );
      this.setCredentials(target, credentials);
      await this.finishPendingSwitch();
      await this.logAction(`Switched to the new location ${describeLocation(target)}`, []);
    }
    this.controller.clearBlock();
    void this.controller.requestSync("full");
  }

  /**
   * Completes a recorded location switch: settings first, then the sync state. Both steps are idempotent,
   * so an interruption at any point is finished by the next call (plugin start, every sync).
   */
  private async finishPendingSwitch(): Promise<void> {
    const pending = this.store.state.pendingSwitch;
    if (!pending) return;
    if (!this.settings.location || !sameLocation(this.settings.location, pending.location)) await this.switchLocation(pending.location);
    completeSwitch(this.store.state);
    await this.store.persist();
  }

  async switchLocation(target: BackendLocation): Promise<void> {
    this.settings.location = toLocation(target);
    this.sizeCache = null;
    this.sizeWarned = false;
    await this.saveSettings();
  }

  openMoveVault(): void {
    void this.openUnlocked(() => new MoveVaultModal(this).open());
  }

  // ───────────────────────── conflicts ─────────────────────────

  private conflictResolver(): ConflictResolver {
    return new ConflictResolver({ crypto: this.crypto, fs: this.fs, store: this.store });
  }

  async dismissConflict(id: string): Promise<void> {
    this.store.state.conflicts = this.store.state.conflicts.filter((c) => c.id !== id);
    await this.store.persist();
    await this.controller.refreshStatus();
  }

  private async keepSyncedVersion(conflict: ConflictRecord, copyHash: string, syncedHash: string): Promise<void> {
    await this.controller.runExclusive(() => this.conflictResolver().keepSynced(conflict, copyHash, syncedHash));
    await this.logAction("Conflict resolved: kept the synced version", [{ action: "trashed", path: conflict.conflictPath as string }]);
    this.controller.notifyChange();
    await this.controller.refreshStatus();
  }

  private async keepConflictCopy(conflict: ConflictRecord, copyHash: string, syncedHash: string): Promise<void> {
    const resolver = this.conflictResolver();
    // Like restoring a version: the replaced content must be in the remote history first.
    if (!(await resolver.canReplaceSynced(conflict))) await this.controller.runNow("full");
    await this.controller.runExclusive(() => resolver.keepCopy(conflict, copyHash, syncedHash));
    await this.logAction("Conflict resolved: kept the copy", [
      { action: "restored", path: conflict.path, other: conflict.conflictPath as string },
      { action: "trashed", path: conflict.conflictPath as string },
    ]);
    this.controller.notifyChange();
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
      new Notice(`Encrypted sync: ${describeError(error, this.tokenList())}`, 10000);
      this.logError(error);
      logUnexpected(this.settings.debugLogging, "sync command", error, this.tokenList());
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
    this.logSync(report);
    if (report.uploaded > 0) void this.warnAboutSize();
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
    this.addCommand({ id: "pull", name: "Pull remote changes", callback: () => void this.syncCommand("pull") });
    // Pushing always pulls and merges first (never a blind or forced push).
    this.addCommand({ id: "push", name: "Push local changes", callback: () => void this.syncCommand("full") });
    this.addCommand({ id: "show-status", name: "Show status", callback: () => this.openStatus() });
    this.addCommand({ id: "show-conflicts", name: "Show conflicts", callback: () => this.openConflicts() });
    this.addCommand({ id: "lock", name: "Lock vault", callback: () => this.lock() });
    this.addCommand({ id: "unlock", name: "Unlock vault", callback: () => void this.promptUnlock() });
    this.addCommand({ id: "change-password", name: "Change password", callback: () => this.openChangePassword() });
    this.addCommand({ id: "setup", name: "Set up / connect repository", callback: () => new SetupWizard(this.app, this).open() });
    this.addCommand({ id: "restore-deleted", name: "Restore deleted files", callback: () => this.openDeletedFiles() });
    this.addCommand({ id: "verify-repository", name: "Verify repository", callback: () => this.openVerify() });
    this.addCommand({ id: "show-activity", name: "Show sync activity", callback: () => this.openActivity() });
    this.addCommand({ id: "move-repository", name: "Move vault to a new repository", callback: () => this.openMoveVault() });
    this.addCommand({
      id: "show-version-history",
      name: "Show version history of current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openVersionHistory(file);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Version history")
            .setIcon("history")
            .onClick(() => void this.openVersionHistory(file)),
        );
      }),
    );
  }

  openChangePassword(): void {
    if (!this.keyManager.isUnlocked) {
      new Notice("Unlock the vault first.");
      return;
    }
    openChangePasswordModal(this.app, MIN_PASSWORD_LENGTH, (current, next) => this.changePassword(current, next));
  }

  openConflicts(): void {
    new ConflictView(this.app, {
      list: () => this.store.state.conflicts,
      dismiss: (id) => this.dismissConflict(id),
      load: (conflict) => this.conflictResolver().load(conflict),
      hash: (data) => this.crypto.hash(data),
      keepSynced: (conflict, copyHash, syncedHash) => this.keepSyncedVersion(conflict, copyHash, syncedHash),
      keepCopy: (conflict, copyHash, syncedHash) => this.keepConflictCopy(conflict, copyHash, syncedHash),
    }).open();
  }

  openStatus(): void {
    new StatusModal(this).open();
  }

  /** Subscribe to status changes (settings tab, status dialog). Returns the unsubscribe function. */
  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private publishStatus(status: SyncStatus): void {
    this.statusBar.render(status);
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, ribbonIcon(status));
      this.ribbonEl.setAttribute("aria-label", `Encrypted sync: ${statusText(status)}`);
    }
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error: unknown) {
        logUnexpected(this.settings.debugLogging, "status listener", error);
      }
    }
  }

  private registerVaultEvents(): void {
    const changed = (): void => {
      this.controller.notifyChange();
      this.explorerStatus.schedule();
    };
    this.registerEvent(this.app.workspace.on("layout-change", () => this.explorerStatus.schedule()));
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.vault.on("delete", changed));
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Keep stable object ids across renames/moves (files and whole folders).
        // Persist only real changes: a fresh state must never be written just because a folder was renamed.
        if (this.store.recordRename(oldPath, file.path)) this.schedulePersist();
        changed();
      }),
    );
  }

  private schedulePersist(): void {
    if (this.persistHandle !== null) window.clearTimeout(this.persistHandle);
    this.persistHandle = window.setTimeout(() => {
      this.persistHandle = null;
      if (!this.controller.isSyncing) this.store.persist().catch((error: unknown) => logUnexpected(this.settings.debugLogging, "persist state", error));
      else this.schedulePersist();
    }, 2000);
  }

  statusSummary(): SyncStatus {
    return this.controller.current;
  }

  /** Whether the remote config seen by the last sync has a recovery key slot. */
  hasRecoverySlot(): boolean | null {
    const config = this.knownConfig;
    return config ? config.keySlots.some((s) => s.type === "recovery") : null;
  }
}

function ribbonIcon(status: SyncStatus): string {
  switch (status.state) {
    case "syncing":
      return "refresh-cw";
    case "offline":
    case "rateLimited":
      return "cloud-off";
    case "locked":
      return "lock";
    case "blocked":
      return "shield-alert";
    case "error":
      return "alert-triangle";
    case "notConfigured":
      return "settings";
    case "idle":
      return status.conflicts > 0 ? "alert-triangle" : "cloud";
  }
}
