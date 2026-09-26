import { basename, dirname, joinPath, pathKey, splitExtension } from "../vault/PathUtils";

/**
 * "Folder/Note.md" → "Folder/Note (conflict 2026-09-26 1a2b3c4d).md". If that name is taken a counter is
 * appended. `isTaken` must answer case-insensitively.
 */
export function conflictPath(path: string, now: number, deviceId: string, isTaken: (candidate: string) => boolean): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const device = deviceId.replace(/-/g, "").slice(0, 8);
  const [stem, ext] = splitExtension(basename(path));
  const dir = dirname(path);
  for (let n = 1; n < 10000; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = joinPath(dir, `${stem} (conflict ${date} ${device}${suffix})${ext}`);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("Could not find a free conflict file name");
}

/** Temporary name used to break rename cycles (visible on purpose so a crash can never hide a file). */
export function temporaryMovePath(path: string, token: string, isTaken: (candidate: string) => boolean): string {
  const [stem, ext] = splitExtension(basename(path));
  const dir = dirname(path);
  for (let n = 0; n < 1000; n++) {
    const candidate = joinPath(dir, `${stem} (sync-move ${token}${n ? ` ${n}` : ""})${ext}`);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("Could not find a free temporary file name");
}

export class PathOccupancy<T> {
  private readonly map = new Map<string, { path: string; value: T }>();

  get(path: string): { path: string; value: T } | undefined {
    return this.map.get(pathKey(path));
  }

  has(path: string): boolean {
    return this.map.has(pathKey(path));
  }

  set(path: string, value: T): void {
    this.map.set(pathKey(path), { path, value });
  }

  delete(path: string): void {
    this.map.delete(pathKey(path));
  }
}
