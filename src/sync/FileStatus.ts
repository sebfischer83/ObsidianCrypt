import type { ConflictRecord } from "../state/LocalState";
import { ancestors } from "../vault/PathUtils";
import type { FileSyncState } from "./SyncEngine";

/** What the file explorer shows next to an item. `synced` files get no mark. */
export type FileMark = "pending" | "conflict" | "skipped" | "ignored";

const FOLDER_PRIORITY: readonly FileMark[] = ["conflict", "pending", "skipped"];

export interface ExplorerItem {
  readonly path: string;
  readonly isFolder: boolean;
}

/**
 * Marks for explorer items. Files: their own state; files unknown to the sync (excluded by ignore rules or
 * settings) are `ignored`. Folders: the most important mark of anything inside (conflict > pending >
 * skipped) – ignored contents never mark a folder.
 */
export function explorerMarks(items: readonly ExplorerItem[], files: ReadonlyMap<string, FileSyncState>, conflicts: readonly ConflictRecord[]): Map<string, FileMark> {
  const own = new Map<string, FileMark>();
  for (const [path, state] of files) if (state !== "synced") own.set(path, state);
  for (const c of conflicts) {
    own.set(c.path, "conflict");
    if (c.conflictPath) own.set(c.conflictPath, "conflict");
  }
  const folders = new Map<string, FileMark>();
  for (const [path, mark] of own) {
    for (const folder of ancestors(path)) {
      const current = folders.get(folder);
      if (current === undefined || FOLDER_PRIORITY.indexOf(mark) < FOLDER_PRIORITY.indexOf(current)) folders.set(folder, mark);
    }
  }
  const out = new Map<string, FileMark>();
  for (const item of items) {
    const mark = item.isFolder ? folders.get(item.path) : (own.get(item.path) ?? (files.has(item.path) ? undefined : "ignored"));
    if (mark) out.set(item.path, mark);
  }
  return out;
}
