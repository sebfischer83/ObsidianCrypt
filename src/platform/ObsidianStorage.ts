import { normalizePath, type App } from "obsidian";
import type { BlobFileStore } from "../state/StateRepository";
import { assertSecretId, MemorySecretStore, type SecretStore } from "../state/SecretStore";
import { toArrayBuffer } from "../util/bytes";

/** Plugin-private files (local sync state). The plugin folder is never synchronised by this plugin. */
export class PluginFolderStore implements BlobFileStore {
  constructor(
    private readonly app: App,
    private readonly folder: string,
  ) {}

  async read(path: string): Promise<Uint8Array | null> {
    const full = normalizePath(`${this.folder}/${path}`);
    if (!(await this.app.vault.adapter.exists(full))) return null;
    return new Uint8Array(await this.app.vault.adapter.readBinary(full));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.folder))) await this.app.vault.adapter.mkdir(this.folder);
    await this.app.vault.adapter.writeBinary(normalizePath(`${this.folder}/${path}`), toArrayBuffer(data));
  }

  async remove(path: string): Promise<void> {
    const full = normalizePath(`${this.folder}/${path}`);
    if (await this.app.vault.adapter.exists(full)) await this.app.vault.adapter.remove(full);
  }
}

interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

/**
 * Obsidian SecretStorage (OS keychain backed, Obsidian ≥ 1.11.4). Falls back to memory only – secrets are
 * never written to data.json.
 */
export class ObsidianSecretStore implements SecretStore {
  private available: boolean;
  /** Set when the platform secret storage rejected a write; secrets then stay in memory only. */
  lastError: unknown = null;
  private readonly fallback = new MemorySecretStore();
  private readonly storage: SecretStorageLike | null;

  constructor(app: App) {
    // Official API since Obsidian 1.11.4 (minAppVersion); the runtime check only guards against broken builds.
    const storage: SecretStorageLike | undefined = app.secretStorage;
    this.storage = storage && typeof storage.getSecret === "function" && typeof storage.setSecret === "function" ? storage : null;
    this.available = this.storage !== null;
  }

  get persistent(): boolean {
    return this.available;
  }

  get(id: string): string | null {
    const memory = this.fallback.get(id);
    if (memory !== null || !this.storage) return memory;
    try {
      const value = this.storage.getSecret(id);
      return value ? value : null;
    } catch (error: unknown) {
      this.lastError = error;
      return null;
    }
  }

  set(id: string, value: string): void {
    assertSecretId(id);
    if (this.storage) {
      try {
        this.storage.setSecret(id, value);
        this.fallback.delete(id);
        return;
      } catch (error: unknown) {
        // Never fail the whole setup because the keychain refused: keep it for this session only.
        this.lastError = error;
        this.available = false;
      }
    }
    this.fallback.set(id, value);
  }

  delete(id: string): void {
    this.fallback.delete(id);
    if (!this.storage) return;
    try {
      // The API has no delete; an empty value is treated as absent.
      this.storage.setSecret(id, "");
    } catch (error: unknown) {
      this.lastError = error;
    }
  }
}

/** Per-device values that must not be shared through other sync tools (not stored in the vault). */
export class DeviceLocalStore {
  constructor(private readonly app: App) {}

  get(key: string): string | null {
    const value: unknown = this.app.loadLocalStorage(key);
    return typeof value === "string" ? value : null;
  }

  set(key: string, value: string): void {
    this.app.saveLocalStorage(key, value);
  }
}
