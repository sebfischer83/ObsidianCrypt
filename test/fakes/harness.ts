import { WebCryptoProvider } from "../../src/crypto/WebCryptoProvider";
import type { VaultKeys } from "../../src/crypto/KeyManager";
import { MemoryStateRepository } from "../../src/state/StateRepository";
import { SyncStateStore } from "../../src/state/SyncStateStore";
import { SyncEngine, type SyncLimits, type SyncMode, type SyncReport } from "../../src/sync/SyncEngine";
import { connectExistingVault, initializeNewVault } from "../../src/sync/VaultSetup";
import type { FilterSettings } from "../../src/vault/SyncFilter";
import { FakeRemoteRepository } from "./FakeRemoteRepository";
import type { RemoteRepository } from "../../src/remote/RemoteRepository";
import { MemoryFileSystem } from "./MemoryFileSystem";

export const crypto = new WebCryptoProvider();
export const PASSWORD = "test password with enough length";

export const DEFAULT_FILTER: FilterSettings = {
  configDir: ".obsidian",
  pluginId: "encrypted-github-sync",
  syncConfigDir: true,
  syncCoreSettings: true,
  syncPlugins: false,
  syncThemesAndSnippets: false,
  syncWorkspace: false,
};

let deviceCounter = 0;

/** One simulated device (local vault + persisted plugin state) connected to a shared remote. */
export class Device {
  readonly fs: MemoryFileSystem;
  readonly repo = new MemoryStateRepository();
  store!: SyncStateStore;
  engine!: SyncEngine;
  keys!: VaultKeys;
  now = 1_790_000_000_000;

  constructor(
    readonly remote: RemoteRepository,
    readonly deviceId: string = `${(++deviceCounter).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    private limits: Partial<SyncLimits> = {},
    fs?: MemoryFileSystem,
  ) {
    this.fs = fs ?? new MemoryFileSystem();
  }

  async open(): Promise<void> {
    this.store = await SyncStateStore.open(this.repo, this.deviceId);
    this.buildEngine();
  }

  private buildEngine(): void {
    this.engine = new SyncEngine({
      crypto,
      fs: this.fs,
      remote: this.remote,
      store: this.store,
      getKeys: () => this.keys,
      filterSettings: DEFAULT_FILTER,
      limits: this.limits,
      deviceId: this.deviceId,
      now: () => this.now,
    });
  }

  /** Changes this device's limits (e.g. the max file size setting). */
  reconfigure(limits: Partial<SyncLimits>): void {
    this.limits = { ...this.limits, ...limits };
    this.buildEngine();
  }

  /** Simulates an app restart: in-memory state is dropped, persisted state is reloaded. */
  async restart(): Promise<void> {
    await this.open();
  }

  async sync(mode: SyncMode = "full"): Promise<SyncReport> {
    return this.engine.sync(mode);
  }

  async createVault(): Promise<string | null> {
    await this.open();
    const result = await initializeNewVault({ crypto, remote: this.remote, store: this.store, password: PASSWORD, deviceId: this.deviceId, kdf: "pbkdf2-sha256" });
    this.keys = result.keys;
    return result.recoveryKey;
  }

  async connect(secret: { password: string } | { recoveryKey: string } = { password: PASSWORD }): Promise<void> {
    await this.open();
    const result = await connectExistingVault({ crypto, remote: this.remote, store: this.store, secret, deviceId: this.deviceId });
    this.keys = result.keys;
  }
}

export async function twoDevices(limits: Partial<SyncLimits> = {}): Promise<{ remote: FakeRemoteRepository; a: Device; b: Device }> {
  const remote = new FakeRemoteRepository();
  const a = new Device(remote, undefined, limits);
  await a.createVault();
  const b = new Device(remote, undefined, limits);
  await b.connect();
  return { remote, a, b };
}
