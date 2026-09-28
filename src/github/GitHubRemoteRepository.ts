import { GitHubError } from "../errors/GitHubError";
import { SyncError } from "../errors/SyncError";
import { serializeVaultConfig, type PublicVaultConfig } from "../manifest/VaultConfig";
import { armor, assertEncrypted, CONFIG_PATH, MANIFEST_PATH, objectIdFromPath, objectPath, parseCommitDevice, unarmor } from "../remote/RemoteLayout";
import type { CommitMetadata, HeadState, ObjectRevision, RemoteChange, RemoteRepository } from "../remote/RemoteRepository";
import { toBase64, utf8Decode } from "../util/bytes";
import { GIT_SHA, ValidationError } from "../util/validate";
import type { EncryptedBlob } from "../crypto/EncryptionFormat";
import type { GitObjectsApi, TreeEntryInput } from "./GitObjectsApi";

export interface GitHubRemoteOptions {
  readonly branch: string;
  /** Envelopes up to this size are armoured and batched into tree requests. */
  readonly inlineThreshold?: number;
  /** Maximum inline content per tree request. */
  readonly maxTreeRequestBytes?: number;
  readonly maxTreeEntries?: number;
}

/**
 * RemoteRepository on top of GitHub's git data API (no local git). All writes go through
 * blob → tree → commit → fast-forward ref update, so several file changes form one atomic commit.
 */
export class GitHubRemoteRepository implements RemoteRepository {
  private readonly branch: string;
  private readonly inlineThreshold: number;
  private readonly maxTreeRequestBytes: number;
  private readonly maxTreeEntries: number;

  constructor(
    private readonly api: GitObjectsApi,
    options: GitHubRemoteOptions,
  ) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(options.branch) || options.branch.includes("..")) throw new ValidationError("branch", "invalid branch name");
    this.branch = options.branch;
    this.inlineThreshold = options.inlineThreshold ?? 512 * 1024;
    this.maxTreeRequestBytes = options.maxTreeRequestBytes ?? 8 * 1024 * 1024;
    this.maxTreeEntries = options.maxTreeEntries ?? 1000;
  }

  async getHead(): Promise<HeadState> {
    const head = await this.api.getBranchHead(this.branch);
    if (head === "empty") return { kind: "empty" };
    if (head !== null) return { kind: "ok", commit: head };
    const repo = await this.api.getRepository();
    if (!repo.exists) throw new GitHubError("RepositoryMissing", 404);
    return (await this.api.hasAnyBranch()) ? { kind: "branchMissing" } : { kind: "empty" };
  }

  readConfig(commit: string): Promise<Uint8Array | null> {
    return this.api.getFileRaw(commit, CONFIG_PATH);
  }

  async readManifest(commit: string): Promise<Uint8Array | null> {
    const stored = await this.api.getFileRaw(commit, MANIFEST_PATH);
    return stored ? unarmor(stored) : null;
  }

  async readObject(commit: string, objectId: string): Promise<Uint8Array> {
    const stored = await this.api.getFileRaw(commit, objectPath(objectId));
    if (!stored) throw new GitHubError("NotFound", 404);
    return unarmor(stored);
  }

  async listObjectRevisions(from: string, objectId: string, limit: number): Promise<ObjectRevision[]> {
    const commits = await this.api.listCommitsForPath(from, objectPath(objectId), limit);
    return commits.slice(0, limit).map((c) => ({ commit: c.sha, date: c.date, device: parseCommitDevice(c.message) }));
  }

  async listObjectIds(commit: string): Promise<{ ids: string[]; complete: boolean }> {
    const tree = await this.api.getTree(await this.api.getCommitTree(commit), true);
    const ids = tree.entries.filter((e) => e.type === "blob").map((e) => objectIdFromPath(e.path)).filter((id): id is string => id !== null);
    return { ids, complete: !tree.truncated };
  }

  async isBootstrapCommit(commit: string): Promise<boolean> {
    const tree = await this.api.getTree(await this.api.getCommitTree(commit), true);
    const blobs = tree.entries.filter((e) => e.type === "blob").map((e) => e.path);
    return !tree.truncated && blobs.length === 1 && blobs[0] === CONFIG_PATH;
  }

  async hasAnyFiles(commit: string): Promise<boolean> {
    const tree = await this.api.getTree(await this.api.getCommitTree(commit), false);
    return tree.entries.length > 0;
  }

  async initialize(config: PublicVaultConfig, meta: CommitMetadata): Promise<string> {
    const head = await this.getHead();
    if (head.kind === "ok") throw new SyncError("ConcurrentRemoteUpdate");
    const content = serializeVaultConfig(config);
    if (head.kind === "empty") {
      const commit = await this.api.createFileInEmptyRepo(CONFIG_PATH, toBase64(content), meta.message, this.branch);
      // An empty repository may name its first branch differently; make sure ours exists.
      const created = await this.getHead();
      if (created.kind !== "ok" && !(await this.api.createBranch(this.branch, commit))) throw new SyncError("ConcurrentRemoteUpdate");
      return commit;
    }
    const tree = await this.api.createTree([{ path: CONFIG_PATH, mode: "100644", type: "blob", content: utf8Decode(content) }], null);
    const commit = await this.api.createCommit(meta.message, tree, []);
    if (!(await this.api.createBranch(this.branch, commit))) throw new SyncError("ConcurrentRemoteUpdate");
    return commit;
  }

  async uploadObject(blob: EncryptedBlob): Promise<string> {
    assertEncrypted(blob.bytes);
    return this.api.createBlobBase64(toBase64(blob.bytes));
  }

  async createCommit(parent: string, changes: readonly RemoteChange[], meta: CommitMetadata): Promise<string> {
    const entries: Array<TreeEntryInput & { inlineBytes: number }> = [];
    for (const change of changes) {
      switch (change.kind) {
        case "putObject":
        case "putManifest": {
          const bytes = change.blob.bytes;
          assertEncrypted(bytes);
          const path = change.kind === "putObject" ? objectPath(change.objectId) : MANIFEST_PATH;
          if (bytes.length <= this.inlineThreshold) {
            const content = armor(bytes);
            entries.push({ path, mode: "100644", type: "blob", content, inlineBytes: content.length });
          } else {
            const sha = await this.api.createBlobBase64(toBase64(bytes));
            entries.push({ path, mode: "100644", type: "blob", sha, inlineBytes: 0 });
          }
          break;
        }
        case "putUploadedObject":
          if (!GIT_SHA.test(change.handle)) throw new GitHubError("InvalidResponse");
          entries.push({ path: objectPath(change.objectId), mode: "100644", type: "blob", sha: change.handle, inlineBytes: 0 });
          break;
        case "deleteObject":
          entries.push({ path: objectPath(change.objectId), mode: "100644", type: "blob", sha: null, inlineBytes: 0 });
          break;
        case "putConfig": {
          const content = utf8Decode(serializeVaultConfig(change.config));
          entries.push({ path: CONFIG_PATH, mode: "100644", type: "blob", content, inlineBytes: content.length });
          break;
        }
      }
    }

    let tree = await this.api.getCommitTree(parent);
    let batch: TreeEntryInput[] = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      tree = await this.api.createTree(batch, tree);
      batch = [];
      batchBytes = 0;
    };
    for (const { inlineBytes, ...entry } of entries) {
      if (batch.length > 0 && (batchBytes + inlineBytes > this.maxTreeRequestBytes || batch.length >= this.maxTreeEntries)) await flush();
      batch.push(entry);
      batchBytes += inlineBytes;
    }
    await flush();
    return this.api.createCommit(meta.message, tree, [parent]);
  }

  async updateHead(expectedParent: string, newCommit: string): Promise<void> {
    const current = await this.api.getBranchHead(this.branch);
    if (current !== expectedParent) {
      if (await this.landed(newCommit, current)) return;
      // GitHub reads can lag behind writes. If the branch still shows an OLDER commit, let the server
      // decide: the update is fast-forward-only, so it can never discard commits we have not seen.
      const staleRead = typeof current === "string" && (await this.isAncestor(current, expectedParent));
      if (!staleRead) throw new SyncError("ConcurrentRemoteUpdate");
    }
    let accepted: boolean;
    try {
      accepted = await this.api.updateBranch(this.branch, newCommit);
    } catch (error: unknown) {
      // Outcome unknown (e.g. connection dropped): look at the branch to decide.
      if (!(error instanceof GitHubError) || error.category !== "Network") throw error;
      const after = await this.api.getBranchHead(this.branch);
      if (after === expectedParent) throw error;
      if (await this.landed(newCommit, after)) return;
      throw new SyncError("ConcurrentRemoteUpdate");
    }
    if (accepted) return;
    // GitHub refused a non-fast-forward: somebody else moved the branch (or an automatic retry of our own
    // successful update was refused because others already built on top of it).
    const after = await this.api.getBranchHead(this.branch);
    if (await this.landed(newCommit, after)) return;
    throw new SyncError("ConcurrentRemoteUpdate");
  }

  /** Our commit is the branch head or already an ancestor of it. */
  private async landed(commit: string, head: string | "empty" | null): Promise<boolean> {
    if (head === null || head === "empty") return false;
    return head === commit || (await this.isAncestor(commit, head));
  }

  async getParents(commit: string): Promise<string[]> {
    return (await this.api.getCommit(commit)).parents;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    const status = await this.api.compare(ancestor, descendant);
    return status === "ahead" || status === "identical";
  }
}
