import type { CryptoProvider } from "../crypto/CryptoProvider";
import { CryptoError } from "../errors/CryptoError";
import { RemoteError } from "../errors/RemoteError";
import { SyncError } from "../errors/SyncError";
import { VaultSyncError } from "../errors/VaultSyncError";
import type { LocalOp } from "../state/LocalState";
import type { LocalFileSystem } from "./LocalFileSystem";
import { pathKey } from "./PathUtils";
import type { HashCacheEntry } from "./VaultScanner";

export interface ApplyContext {
  readonly fs: LocalFileSystem;
  readonly crypto: CryptoProvider;
  readonly localMap: Record<string, string>;
  readonly hashCache: Record<string, HashCacheEntry>;
  /** Downloads, decrypts and verifies the content (GCM + manifest hash). Throws on any failure. */
  readonly fetchContent: (objectId: string, contentHash: string, size: number) => Promise<Uint8Array>;
  /**
   * Recovery mode (re-running a journal after a crash): an op whose post-condition already holds counts as
   * done even if its pre-condition no longer does.
   */
  readonly recovery: boolean;
  readonly onProgress?: (done: number, total: number) => void;
  /** Checked before every op: true aborts the apply (the journal is resumed on the next run). */
  readonly shouldStop?: () => boolean;
}

export interface OpFailure {
  readonly index: number;
  readonly reason: "diverged" | "dependency" | "error";
  readonly error?: VaultSyncError;
}

export interface ApplyResult {
  readonly failures: OpFailure[];
  /** Object ids whose ops did not (all) succeed; their merge base must not advance. */
  readonly divergedIds: Set<string>;
  readonly applied: number;
}

/**
 * Executes local operations with re-checked pre-conditions. Every overwrite/delete verifies that the
 * current local content still equals what the planner saw; otherwise the op is skipped ("diverged") and
 * the next merge turns it into a conflict. Content is fully decrypted and verified in memory before the
 * single write call, so a failed download or authentication can never touch the existing file.
 *
 * Network errors propagate (the journal stays and is resumed on the next run).
 */
export async function applyLocalOps(ops: readonly LocalOp[], ctx: ApplyContext): Promise<ApplyResult> {
  const failed = new Set<number>();
  const failures: OpFailure[] = [];
  const divergedIds = new Set<string>();
  let applied = 0;

  const markFailed = (index: number, op: LocalOp, reason: OpFailure["reason"], error?: VaultSyncError): void => {
    failed.add(index);
    failures.push(error ? { index, reason, error } : { index, reason });
    if (op.objectId) divergedIds.add(op.objectId);
    if (op.op === "move" && op.resultObjectId) divergedIds.add(op.resultObjectId);
    if (op.op === "adopt" && op.replacesObjectId) divergedIds.add(op.replacesObjectId);
  };

  for (let i = 0; i < ops.length; i++) {
    if (ctx.shouldStop?.()) throw new SyncError("InvalidState", "synchronisation stopped");
    const op = ops[i] as LocalOp;
    if (op.requires.some((r) => failed.has(r))) {
      markFailed(i, op, "dependency");
      continue;
    }
    try {
      const ok = await applyOne(op, ctx);
      if (ok) applied++;
      else markFailed(i, op, "diverged");
    } catch (error: unknown) {
      // Network/auth/rate-limit problems abort the whole apply; the journal is resumed on the next run.
      if (error instanceof RemoteError && error.category !== "NotFound") throw error;
      // The vault was locked (plugin unloading or user action): stop, the journal resumes later.
      if (error instanceof CryptoError && error.code === "Locked") throw error;
      if (error instanceof VaultSyncError) markFailed(i, op, "error", error);
      else markFailed(i, op, "error", new SyncError("LocalWriteFailed", undefined, { cause: error }));
    }
    ctx.onProgress?.(i + 1, ops.length);
  }
  return { failures, divergedIds, applied };
}

async function currentHash(ctx: ApplyContext, path: string): Promise<string | null> {
  return (await currentState(ctx, path))?.hash ?? null;
}

/** Hash plus the stat it belongs to; `stable` is false if the file changed while it was being read. */
async function currentState(ctx: ApplyContext, path: string): Promise<{ hash: string; size: number; mtime: number; stable: boolean } | null> {
  if (!(await ctx.fs.exists(path))) return null;
  const before = await ctx.fs.stat(path);
  if (!before) return null;
  const data = await ctx.fs.read(path);
  const hash = await ctx.crypto.hash(data);
  const after = await ctx.fs.stat(path);
  const stable = !!after && after.size === before.size && after.mtime === before.mtime && after.size === data.length;
  return { hash, size: before.size, mtime: before.mtime, stable };
}

/** Caches a hash only if it was verified against an unchanging file (a later edit must stay visible). */
function cacheVerified(ctx: ApplyContext, path: string, state: { hash: string; size: number; mtime: number; stable: boolean }): void {
  if (state.stable) ctx.hashCache[path] = { size: state.size, mtime: state.mtime, hash: state.hash };
  else delete ctx.hashCache[path];
}

function remapCache(ctx: ApplyContext, from: string, to: string): void {
  const cached = ctx.hashCache[from];
  delete ctx.hashCache[from];
  if (cached) ctx.hashCache[to] = cached;
}

async function applyOne(op: LocalOp, ctx: ApplyContext): Promise<boolean> {
  switch (op.op) {
    case "move": {
      const fromExists = await ctx.fs.exists(op.from);
      const caseOnly = op.from !== op.to && pathKey(op.from) === pathKey(op.to);
      const toExists = caseOnly ? false : await ctx.fs.exists(op.to);
      if (fromExists && !toExists) {
        // Update the identity map BEFORE renaming, so the resulting rename event is a no-op.
        const tracked = ctx.localMap[op.from];
        delete ctx.localMap[op.from];
        const resultId = op.resultObjectId ?? tracked ?? null;
        if (resultId) ctx.localMap[op.to] = resultId;
        try {
          await ctx.fs.rename(op.from, op.to);
        } catch (error: unknown) {
          delete ctx.localMap[op.to];
          if (tracked) ctx.localMap[op.from] = tracked;
          throw error;
        }
        remapCache(ctx, op.from, op.to);
        return true;
      }
      if (ctx.recovery && !fromExists && toExists) {
        delete ctx.localMap[op.from];
        const resultId = op.resultObjectId ?? op.objectId;
        if (resultId) ctx.localMap[op.to] = resultId;
        return true;
      }
      return false;
    }
    case "trash": {
      const hash = await currentHash(ctx, op.path);
      if (hash === null) {
        delete ctx.localMap[op.path];
        delete ctx.hashCache[op.path];
        return true; // already gone
      }
      if (hash !== op.expectedHash) return diverged(ctx, op.path);
      await ctx.fs.trash(op.path);
      delete ctx.localMap[op.path];
      delete ctx.hashCache[op.path];
      return true;
    }
    case "adopt": {
      const hash = await currentHash(ctx, op.path);
      if (hash !== op.expectedHash) return diverged(ctx, op.path);
      ctx.localMap[op.path] = op.objectId;
      return true;
    }
    case "untrack": {
      for (const [path, id] of Object.entries(ctx.localMap)) {
        if (id !== op.objectId) continue;
        if (await ctx.fs.exists(path)) return false; // the file came back: let the next merge decide
        delete ctx.localMap[path];
      }
      return true;
    }
    case "write": {
      const current = await currentState(ctx, op.path);
      const hash = current?.hash ?? null;
      if (current && hash === op.contentHash) {
        ctx.localMap[op.path] = op.objectId;
        cacheVerified(ctx, op.path, current);
        return true;
      }
      if (hash === null ? op.expectedCurrentHash !== null : hash !== op.expectedCurrentHash) return diverged(ctx, op.path);
      // Fully decrypted + authenticated + hash-verified before anything is written.
      const data = await ctx.fetchContent(op.objectId, op.contentHash, op.size);
      // Re-check right before writing to keep the race window with the editor minimal.
      const again = await currentHash(ctx, op.path);
      if (again !== hash) return diverged(ctx, op.path);
      await ctx.fs.write(op.path, data);
      ctx.localMap[op.path] = op.objectId;
      const written = await currentState(ctx, op.path);
      if (!written || written.hash !== op.contentHash) {
        // Most likely the user/editor changed the file right after our write. Never write again blindly:
        // the base of this object stays behind, so the next merge treats the content as a local change and
        // preserves both versions. (The overwritten version equals the merge base and is in the history.)
        delete ctx.hashCache[op.path];
        return false;
      }
      cacheVerified(ctx, op.path, written);
      return true;
    }
  }
}

/**
 * A precondition failed: the file is not what the plan expected. The plan may have been built from a stale
 * hash-cache entry (content changed while size and mtime stayed, e.g. 2-second mtime granularity), so the
 * entry is dropped – the next scan re-hashes the file and the merge sees the real local change instead of
 * diverging forever.
 */
function diverged(ctx: ApplyContext, path: string): false {
  delete ctx.hashCache[path];
  return false;
}
