import { RemoteError } from "../errors/RemoteError";
import { expectArray, expectRecord, expectString, GIT_SHA, isRecord } from "../util/validate";
import { encodePath, type GitHubClient } from "./GitHubClient";

export interface TreeEntryInput {
  readonly path: string;
  readonly mode: "100644";
  readonly type: "blob";
  /** Existing blob sha, or null to delete the path. */
  readonly sha?: string | null;
  /** Inline UTF-8 content (GitHub creates the blob). */
  readonly content?: string;
}

export interface TreeListing {
  readonly sha: string;
  readonly truncated: boolean;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly type: string; readonly sha: string }>;
}

/** Thin, validated wrappers around the GitHub git data API. */
export class GitObjectsApi {
  private readonly repoPath: string;

  constructor(
    private readonly client: GitHubClient,
    readonly owner: string,
    readonly repo: string,
  ) {
    this.repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async getRepository(): Promise<{ exists: boolean; canPush: boolean; isPrivate: boolean; defaultBranch: string | null; sizeBytes: number | null }> {
    const { status, data } = await this.client.json<unknown>("GET", this.repoPath, { allow: [404] });
    if (status === 404 || !isRecord(data)) return { exists: false, canPush: false, isPrivate: false, defaultBranch: null, sizeBytes: null };
    const permissions = isRecord(data.permissions) ? data.permissions : {};
    return {
      exists: true,
      canPush: permissions.push === true || permissions.admin === true || permissions.maintain === true,
      isPrivate: data.private === true,
      defaultBranch: typeof data.default_branch === "string" ? data.default_branch : null,
      // GitHub reports KiB, recomputed lazily (may lag behind recent pushes).
      sizeBytes: typeof data.size === "number" && Number.isFinite(data.size) && data.size >= 0 ? data.size * 1024 : null,
    };
  }

  /**
   * Creates this (missing) repository as a private, empty repository – under the token's user or, if the
   * owner is an organisation, in that organisation. Needs repository administration permission.
   */
  async createPrivateRepository(): Promise<void> {
    const { data: user } = await this.client.json<unknown>("GET", "/user");
    const login = expectString(expectRecord(user, "user").login, "user.login");
    const path = login.toLowerCase() === this.owner.toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(this.owner)}/repos`;
    await this.client.json<unknown>("POST", path, {
      body: { name: this.repo, private: true, auto_init: false, description: "Encrypted Obsidian vault" },
      retryable: false,
    });
  }

  async hasAnyBranch(): Promise<boolean> {
    const { status, data } = await this.client.json<unknown>("GET", `${this.repoPath}/branches?per_page=1`, { allow: [404, 409] });
    if (status !== 200) return false;
    return Array.isArray(data) && data.length > 0;
  }

  /** Branch head commit; "empty" for a repository without commits, null if the branch is missing. */
  async getBranchHead(branch: string): Promise<string | "empty" | null> {
    const { status, data } = await this.client.json<unknown>("GET", `${this.repoPath}/git/ref/heads/${encodePath(branch)}`, { allow: [404, 409] });
    if (status === 409) return "empty";
    if (status === 404) return null;
    const record = expectRecord(data, "ref");
    return expectString(expectRecord(record.object, "ref.object").sha, "ref.object.sha", GIT_SHA);
  }

  async getCommitTree(commit: string): Promise<string> {
    return (await this.getCommit(commit)).tree;
  }

  async getCommit(commit: string): Promise<{ tree: string; parents: string[] }> {
    const { data } = await this.client.json<unknown>("GET", `${this.repoPath}/git/commits/${sha(commit)}`);
    const record = expectRecord(data, "commit");
    return {
      tree: expectString(expectRecord(record.tree, "commit.tree").sha, "commit.tree.sha", GIT_SHA),
      parents: expectArray(record.parents, "commit.parents").map((p) => expectString(expectRecord(p, "parent").sha, "parent.sha", GIT_SHA)),
    };
  }

  async getTree(tree: string, recursive: boolean): Promise<TreeListing> {
    const { data } = await this.client.json<unknown>("GET", `${this.repoPath}/git/trees/${sha(tree)}${recursive ? "?recursive=1" : ""}`);
    const record = expectRecord(data, "tree");
    return {
      sha: expectString(record.sha, "tree.sha", GIT_SHA),
      truncated: record.truncated === true,
      entries: expectArray(record.tree, "tree.tree").map((e) => {
        const entry = expectRecord(e, "tree.entry");
        return { path: expectString(entry.path, "entry.path"), type: expectString(entry.type, "entry.type"), sha: expectString(entry.sha, "entry.sha") };
      }),
    };
  }

  /** Commits reachable from `from` that touched `path`, newest first (GitHub caps `perPage` at 100). */
  async listCommitsForPath(from: string, path: string, perPage: number): Promise<Array<{ sha: string; date: number; message: string }>> {
    const query = `sha=${sha(from)}&path=${encodeURIComponent(path)}&per_page=${Math.min(100, Math.max(1, Math.floor(perPage)))}`;
    const { data } = await this.client.json<unknown>("GET", `${this.repoPath}/commits?${query}`);
    return expectArray(data, "commits").map((c) => {
      const record = expectRecord(c, "commit");
      const commit = expectRecord(record.commit, "commit.commit");
      const date = Date.parse(expectString(expectRecord(commit.committer, "commit.committer").date, "commit.committer.date"));
      if (!Number.isFinite(date)) throw new RemoteError("InvalidResponse");
      return { sha: expectString(record.sha, "commit.sha", GIT_SHA), date, message: expectString(commit.message, "commit.message") };
    });
  }

  /** Raw file content at a commit, or null if the path does not exist. */
  async getFileRaw(commit: string, path: string): Promise<Uint8Array | null> {
    const response = await this.client.raw(`${this.repoPath}/contents/${encodePath(path)}?ref=${sha(commit)}`, { allow: [404] });
    if (response.status === 404) return null;
    return response.body;
  }

  async createBlobBase64(contentBase64: string): Promise<string> {
    const { data } = await this.client.json<unknown>("POST", `${this.repoPath}/git/blobs`, {
      body: { content: contentBase64, encoding: "base64" },
      retryable: true,
    });
    return expectString(expectRecord(data, "blob").sha, "blob.sha", GIT_SHA);
  }

  async createTree(entries: readonly TreeEntryInput[], baseTree: string | null): Promise<string> {
    const { data } = await this.client.json<unknown>("POST", `${this.repoPath}/git/trees`, {
      body: baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries },
      retryable: true,
    });
    return expectString(expectRecord(data, "tree").sha, "tree.sha", GIT_SHA);
  }

  async createCommit(message: string, tree: string, parents: readonly string[]): Promise<string> {
    const { data } = await this.client.json<unknown>("POST", `${this.repoPath}/git/commits`, {
      body: { message, tree, parents },
      retryable: true,
    });
    return expectString(expectRecord(data, "commit").sha, "commit.sha", GIT_SHA);
  }

  /** Fast-forward-only ref update (never forced). Returns false if GitHub rejected it (422). */
  async updateBranch(branch: string, commit: string): Promise<boolean> {
    const { status } = await this.client.json<unknown>("PATCH", `${this.repoPath}/git/refs/heads/${encodePath(branch)}`, {
      body: { sha: commit, force: false },
      allow: [409, 422],
      retryable: false,
    });
    return status === 200;
  }

  /** Creates a branch; returns false if it already exists. */
  async createBranch(branch: string, commit: string): Promise<boolean> {
    const { status } = await this.client.json<unknown>("POST", `${this.repoPath}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: commit },
      allow: [422],
      retryable: false,
    });
    return status === 201 || status === 200;
  }

  /** Creates the very first commit of an empty repository (git data API is unavailable there). */
  async createFileInEmptyRepo(path: string, contentBase64: string, message: string, branch: string): Promise<string> {
    const { data } = await this.client.json<unknown>("PUT", `${this.repoPath}/contents/${encodePath(path)}`, {
      body: { message, content: contentBase64, branch },
      retryable: false,
    });
    const record = expectRecord(data, "contents");
    return expectString(expectRecord(record.commit, "contents.commit").sha, "contents.commit.sha", GIT_SHA);
  }

  /** "ahead" | "behind" | "identical" | "diverged", or null if one of the commits is unknown. */
  async compare(base: string, head: string): Promise<string | null> {
    const { status, data } = await this.client.json<unknown>("GET", `${this.repoPath}/compare/${sha(base)}...${sha(head)}?per_page=1`, {
      allow: [404, 422],
    });
    if (status !== 200) return null;
    return expectString(expectRecord(data, "compare").status, "compare.status");
  }
}

function sha(value: string): string {
  if (!GIT_SHA.test(value)) throw new RemoteError("InvalidResponse");
  return value;
}
