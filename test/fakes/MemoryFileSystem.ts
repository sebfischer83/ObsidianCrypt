import type { ListFilter, LocalFileInfo, LocalFileSystem } from "../../src/vault/LocalFileSystem";
import { ancestors, pathKey } from "../../src/vault/PathUtils";
import { utf8Decode, utf8Encode } from "../../src/util/bytes";

interface StoredFile {
  path: string;
  data: Uint8Array;
  mtime: number;
}

/** In-memory vault. Case-insensitive by default (like Windows/macOS/iOS). */
export class MemoryFileSystem implements LocalFileSystem {
  private readonly files = new Map<string, StoredFile>();
  readonly trashed: Array<{ path: string; data: Uint8Array }> = [];
  private clock = 1_700_000_000_000;
  /** Failure injection for writes. */
  failWrite: ((path: string) => boolean) | null = null;
  /** Hook invoked before every write (e.g. to simulate a concurrent user edit). */
  beforeWrite: ((path: string) => void) | null = null;
  /** Hook invoked after every write (e.g. the editor saving right after a download). */
  afterWrite: ((path: string) => void) | null = null;
  writeCount = 0;
  readCount = 0;

  constructor(private readonly caseInsensitive = true) {}

  private key(path: string): string {
    return this.caseInsensitive ? pathKey(path) : path;
  }

  async list(filter: ListFilter): Promise<LocalFileInfo[]> {
    const out: LocalFileInfo[] = [];
    for (const file of this.files.values()) {
      if (ancestors(file.path).some((folder) => !filter.shouldDescend(folder))) continue;
      out.push({ path: file.path, size: file.data.length, mtime: file.mtime });
    }
    return out;
  }

  async stat(path: string): Promise<LocalFileInfo | null> {
    const file = this.files.get(this.key(path));
    return file ? { path: file.path, size: file.data.length, mtime: file.mtime } : null;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.key(path));
    if (!file) throw new Error("ENOENT");
    this.readCount++;
    return file.data.slice();
  }

  /** Atomic create-only write (like Vault.createBinary): fails if the file exists at the moment of writing. */
  async create(path: string, data: Uint8Array): Promise<void> {
    this.beforeWrite?.(path);
    if (this.files.has(this.key(path))) throw new Error("EEXIST");
    if (this.failWrite?.(path)) throw new Error("EIO");
    this.writeCount++;
    this.files.set(this.key(path), { path, data: data.slice(), mtime: this.tick() });
    this.afterWrite?.(path);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.beforeWrite?.(path);
    if (this.failWrite?.(path)) throw new Error("EIO");
    this.writeCount++;
    const existing = this.files.get(this.key(path));
    this.files.set(this.key(path), { path: existing?.path ?? path, data: data.slice(), mtime: this.tick() });
    this.afterWrite?.(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(this.key(from));
    if (!file) throw new Error("ENOENT");
    if (this.key(from) !== this.key(to) && this.files.has(this.key(to))) throw new Error("EEXIST");
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...file, path: to });
  }

  async trash(path: string): Promise<void> {
    const file = this.files.get(this.key(path));
    if (!file) throw new Error("ENOENT");
    this.files.delete(this.key(path));
    this.trashed.push({ path: file.path, data: file.data });
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.key(path));
  }

  // ── test helpers ──

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  /** Changes the content but keeps the modification time (coarse mtime file systems, mtime-preserving tools). */
  setTextKeepingMtime(path: string, text: string): void {
    const existing = this.files.get(this.key(path));
    if (!existing) throw new Error("ENOENT");
    this.files.set(this.key(path), { ...existing, data: utf8Encode(text) });
  }

  setText(path: string, text: string): void {
    this.setBytes(path, utf8Encode(text));
  }

  setBytes(path: string, data: Uint8Array): void {
    const existing = this.files.get(this.key(path));
    this.files.set(this.key(path), { path: existing?.path ?? path, data: data.slice(), mtime: this.tick() });
  }

  text(path: string): string | null {
    const file = this.files.get(this.key(path));
    return file ? utf8Decode(file.data) : null;
  }

  bytes(path: string): Uint8Array | null {
    return this.files.get(this.key(path))?.data ?? null;
  }

  remove(path: string): void {
    this.files.delete(this.key(path));
  }

  move(from: string, to: string): void {
    const file = this.files.get(this.key(from));
    if (!file) throw new Error("ENOENT");
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...file, path: to });
  }

  paths(): string[] {
    return [...this.files.values()].map((f) => f.path).sort();
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.files.values()) out[f.path] = utf8Decode(f.data);
    return out;
  }
}
