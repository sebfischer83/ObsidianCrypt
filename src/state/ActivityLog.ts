import type { FileChange, FileChangeAction } from "../sync/SyncEngine";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { isRecord } from "../util/validate";
import type { BlobFileStore } from "./StateRepository";

export type ActivityKind = "sync" | "error" | "action";

export interface ActivityEntry {
  readonly time: number;
  readonly kind: ActivityKind;
  /** Short human readable line (never file contents). */
  readonly summary: string;
  readonly changes: readonly FileChange[];
  /** Changes left out because the entry was too long. */
  readonly omitted: number;
}

const ACTIONS: readonly FileChangeAction[] = ["downloaded", "uploaded", "movedLocally", "movedRemotely", "deletedLocally", "deletedRemotely", "conflict", "restored", "trashed"];
const KINDS: readonly ActivityKind[] = ["sync", "error", "action"];

/**
 * Local history of what synchronisation did on this device (which files were downloaded, uploaded, moved,
 * deleted, restored). Stored in the plugin folder next to the sync state, never uploaded. Bounded in size;
 * a damaged file simply starts a new log.
 */
export class ActivityLog {
  private list: ActivityEntry[] = [];

  constructor(
    private readonly store: BlobFileStore,
    private readonly fileName: string,
    private readonly maxEntries = 200,
    private readonly maxChangesPerEntry = 500,
  ) {}

  async load(): Promise<void> {
    try {
      const bytes = await this.store.read(this.fileName);
      this.list = bytes ? parseEntries(JSON.parse(utf8Decode(bytes))) : [];
    } catch {
      this.list = [];
    }
  }

  /** Newest first. */
  get entries(): readonly ActivityEntry[] {
    return this.list;
  }

  async add(kind: ActivityKind, summary: string, changes: readonly FileChange[] = [], time = Date.now()): Promise<void> {
    // Automatic retries while offline would otherwise fill the log with the same error.
    const last = this.list[0];
    if (kind === "error" && last?.kind === "error" && last.summary === summary) return;
    const kept = changes.slice(0, this.maxChangesPerEntry);
    this.list = [{ time, kind, summary, changes: kept, omitted: changes.length - kept.length }, ...this.list].slice(0, this.maxEntries);
    await this.save();
  }

  async clear(): Promise<void> {
    this.list = [];
    await this.save();
  }

  private async save(): Promise<void> {
    await this.store.write(this.fileName, utf8Encode(JSON.stringify(this.list)));
  }
}

function parseEntries(raw: unknown): ActivityEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ActivityEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.time !== "number" || typeof item.summary !== "string" || !KINDS.includes(item.kind as ActivityKind)) continue;
    const changes: FileChange[] = [];
    for (const c of Array.isArray(item.changes) ? item.changes : []) {
      if (!isRecord(c) || typeof c.path !== "string" || !ACTIONS.includes(c.action as FileChangeAction)) continue;
      changes.push(typeof c.other === "string" ? { action: c.action as FileChangeAction, path: c.path, other: c.other } : { action: c.action as FileChangeAction, path: c.path });
    }
    out.push({ time: item.time, kind: item.kind as ActivityKind, summary: item.summary, changes, omitted: typeof item.omitted === "number" ? item.omitted : 0 });
  }
  return out;
}
