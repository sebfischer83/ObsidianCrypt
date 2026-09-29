import { normalizePath, TFile, type App, type DataAdapter } from "obsidian";
import type { ListFilter, LocalFileInfo, LocalFileSystem } from "../vault/LocalFileSystem";
import { ancestors, dirname, pathKey } from "../vault/PathUtils";
import { toArrayBuffer } from "../util/bytes";

/**
 * LocalFileSystem over the Obsidian Vault API (regular files: keeps editors, caches and events
 * consistent) and the DataAdapter (hidden files such as `.obsidian/*` or `.vaultsyncignore`).
 * Uses only APIs available on desktop and mobile.
 */
export class ObsidianFileSystem implements LocalFileSystem {
  private readonly adapter: DataAdapter;

  constructor(
    private readonly app: App,
    private readonly hiddenRoots: () => string[],
    private readonly hiddenFiles: readonly string[] = [".vaultsyncignore"],
  ) {
    this.adapter = app.vault.adapter;
  }

  async list(filter: ListFilter): Promise<LocalFileInfo[]> {
    const out: LocalFileInfo[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (ancestors(file.path).some((folder) => !filter.shouldDescend(folder))) continue;
      out.push({ path: file.path, size: file.stat.size, mtime: file.stat.mtime });
    }
    for (const path of this.hiddenFiles) {
      const info = await this.stat(path);
      if (info) out.push(info);
    }
    for (const root of this.hiddenRoots()) {
      if (filter.shouldDescend(root)) await this.listHidden(root, filter, out);
    }
    return out;
  }

  private async listHidden(folder: string, filter: ListFilter, out: LocalFileInfo[]): Promise<void> {
    if (!(await this.adapter.exists(folder))) return;
    const listed = await this.adapter.list(folder);
    for (const file of listed.files) {
      const path = normalizePath(file);
      if (!filter.includes(path)) continue;
      const info = await this.stat(path);
      if (info) out.push(info);
    }
    for (const sub of listed.folders) {
      const path = normalizePath(sub);
      if (filter.shouldDescend(path)) await this.listHidden(path, filter, out);
    }
  }

  async stat(path: string): Promise<LocalFileInfo | null> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    if (file) return { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
    const stat = await this.adapter.stat(normalized);
    if (!stat || stat.type !== "file") return null;
    return { path: normalized, size: stat.size, mtime: stat.mtime };
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    const buffer = file ? await this.app.vault.readBinary(file) : await this.adapter.readBinary(normalized);
    return new Uint8Array(buffer);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const buffer = toArrayBuffer(data);
    const file = this.app.vault.getFileByPath(normalized);
    if (file) {
      await this.app.vault.modifyBinary(file, buffer);
      return;
    }
    await this.ensureFolder(dirname(normalized));
    if (this.isHidden(normalized) || (await this.adapter.exists(normalized))) {
      await this.adapter.writeBinary(normalized, buffer);
    } else {
      await this.app.vault.createBinary(normalized, buffer);
    }
  }

  async create(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(normalized) || (await this.adapter.exists(normalized))) throw new Error("Destination exists");
    await this.ensureFolder(dirname(normalized));
    const buffer = toArrayBuffer(data);
    // Vault.createBinary itself refuses existing files; hidden paths are only written by this plugin (under its mutex).
    if (this.isHidden(normalized)) await this.adapter.writeBinary(normalized, buffer);
    else await this.app.vault.createBinary(normalized, buffer);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    const caseOnly = src !== dst && pathKey(src) === pathKey(dst);
    if (!caseOnly && (await this.adapter.exists(dst))) throw new Error("Destination exists");
    await this.ensureFolder(dirname(dst));
    const file = this.app.vault.getFileByPath(src);
    // Vault.rename (unlike FileManager.renameFile) does not rewrite links in other notes.
    if (file instanceof TFile) await this.app.vault.rename(file, dst);
    else await this.adapter.rename(src, dst);
  }

  async trash(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getFileByPath(normalized);
    // Always the vault-local ".trash" folder: recoverable regardless of the user's delete preference.
    if (file) await this.app.vault.trash(file, false);
    else await this.adapter.trashLocal(normalized);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  private isHidden(path: string): boolean {
    return path.split("/").some((segment) => segment.startsWith("."));
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    for (const dir of [...ancestors(`${folder}/x`)]) {
      if (await this.adapter.exists(dir)) continue;
      if (this.isHidden(dir)) await this.adapter.mkdir(dir);
      else await this.app.vault.createFolder(dir);
    }
  }
}
