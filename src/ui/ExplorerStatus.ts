import { TFolder, type App, type TAbstractFile } from "obsidian";
import type { ConflictRecord } from "../state/LocalState";
import { explorerMarks, type ExplorerItem } from "../sync/FileStatus";
import type { FileSyncState } from "../sync/SyncEngine";

const ATTRIBUTE = "data-encrypted-sync";

const LABELS: Record<string, string> = {
  pending: "Not synchronised yet",
  conflict: "Synchronisation conflict",
  skipped: "Not synchronised (too large or unreadable)",
  ignored: "Excluded from synchronisation",
};

/** The parts of Obsidian's (undocumented) file explorer view used here; everything is optional. */
interface FileExplorerLike {
  readonly fileItems?: Record<string, { readonly file?: TAbstractFile; readonly selfEl?: HTMLElement; readonly titleEl?: HTMLElement }>;
}

/**
 * Small marks in the file explorer for files that are not in sync. Obsidian has no public API for this, so
 * the explorer's item elements are decorated defensively: if its internals change, nothing is shown and
 * nothing breaks.
 */
export class ExplorerStatus {
  private files: ReadonlyMap<string, FileSyncState> | null = null;
  private handle: number | null = null;
  enabled = true;

  constructor(
    private readonly app: App,
    private readonly conflicts: () => readonly ConflictRecord[],
  ) {}

  /** New per-file states from a local scan. */
  update(files: ReadonlyMap<string, FileSyncState>): void {
    this.files = files;
    this.schedule();
  }

  /** Re-applies the marks soon (explorer items are created and re-rendered by Obsidian). */
  schedule(): void {
    if (this.handle !== null) return;
    this.handle = window.setTimeout(() => {
      this.handle = null;
      this.render();
    }, 250);
  }

  render(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const items = (leaf.view as unknown as FileExplorerLike).fileItems;
      if (!items) continue;
      const list: ExplorerItem[] = [];
      for (const [path, item] of Object.entries(items)) if (item.file) list.push({ path, isFolder: item.file instanceof TFolder });
      const marks = this.enabled && this.files ? explorerMarks(list, this.files, this.conflicts()) : new Map();
      for (const [path, item] of Object.entries(items)) {
        const el = item.selfEl ?? item.titleEl;
        if (!el || path === "/") continue;
        const mark = marks.get(path);
        if (mark) {
          if (el.getAttribute(ATTRIBUTE) !== mark) {
            el.setAttribute(ATTRIBUTE, mark);
            el.setAttribute("data-encrypted-sync-label", LABELS[mark] ?? "");
          }
        } else if (el.hasAttribute(ATTRIBUTE)) {
          el.removeAttribute(ATTRIBUTE);
          el.removeAttribute("data-encrypted-sync-label");
        }
      }
    }
  }

  clear(): void {
    this.enabled = false;
    this.render();
  }

  destroy(): void {
    if (this.handle !== null) window.clearTimeout(this.handle);
    this.clear();
  }
}
