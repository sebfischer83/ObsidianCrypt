import { GitHubError } from "../../src/errors/GitHubError";
import { SyncError } from "../../src/errors/SyncError";
import { serializeVaultConfig, type PublicVaultConfig } from "../../src/manifest/VaultConfig";
import { assertEncrypted, CONFIG_PATH, MANIFEST_PATH, objectPath, parseCommitDevice } from "../../src/remote/RemoteLayout";
import type { CommitMetadata, HeadState, ObjectRevision, RemoteChange, RemoteRepository } from "../../src/remote/RemoteRepository";
import { toHex } from "../../src/util/bytes";

interface Commit {
  readonly sha: string;
  readonly parent: string | null;
  readonly files: Map<string, Uint8Array>;
  readonly message: string;
  readonly date: number;
}

export type CrashPoint = "afterBlobUpload" | "afterTreeCreation" | "afterCommitCreation" | "beforeRefUpdate" | "afterRefUpdate";

export class CrashError extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
  }
}

/** In-memory stand-in for the GitHub git data model (commits, trees as file maps, branch ref). */
export class FakeRemoteRepository implements RemoteRepository {
  readonly commits = new Map<string, Commit>();
  head: string | null = null;
  /** True once any commit exists (distinguishes "empty repo" from "branch missing"). */
  hasCommits = false;
  crashAt: CrashPoint | null = null;
  /** Called right before the CAS in updateHead (simulate another device pushing in between). */
  beforeUpdateHead: (() => Promise<void>) | null = null;
  offline = false;
  requestCount = 0;
  private counter = 0;

  private touch(): void {
    this.requestCount++;
    if (this.offline) throw new GitHubError("Network");
  }

  private crash(point: CrashPoint): void {
    if (this.crashAt === point) {
      this.crashAt = null;
      throw new CrashError(point);
    }
  }

  private newSha(): string {
    this.counter++;
    return toHex(new TextEncoder().encode(`commit-${this.counter}`.padEnd(20, "-"))).slice(0, 40);
  }

  /** Commit timestamps: one minute apart, deterministic. */
  private commitDate(): number {
    return 1_790_000_000_000 + this.counter * 60_000;
  }

  private commit(sha: string): Commit {
    const c = this.commits.get(sha);
    if (!c) throw new GitHubError("NotFound", 404);
    return c;
  }

  async getHead(): Promise<HeadState> {
    this.touch();
    if (this.head) return { kind: "ok", commit: this.head };
    return this.hasCommits ? { kind: "branchMissing" } : { kind: "empty" };
  }

  async readConfig(commit: string): Promise<Uint8Array | null> {
    this.touch();
    return this.commit(commit).files.get(CONFIG_PATH)?.slice() ?? null;
  }

  async readManifest(commit: string): Promise<Uint8Array | null> {
    this.touch();
    return this.commit(commit).files.get(MANIFEST_PATH)?.slice() ?? null;
  }

  /** Hook invoked on every object download (e.g. to simulate a user edit during a pull). */
  onReadObject: ((objectId: string) => void) | null = null;
  objectReads = 0;

  async readObject(commit: string, objectId: string): Promise<Uint8Array> {
    this.touch();
    this.objectReads++;
    this.onReadObject?.(objectId);
    const data = this.commit(commit).files.get(objectPath(objectId));
    if (!data) throw new GitHubError("NotFound", 404);
    return data.slice();
  }

  async listObjectRevisions(from: string, objectId: string, limit: number): Promise<ObjectRevision[]> {
    this.touch();
    const path = objectPath(objectId);
    const out: ObjectRevision[] = [];
    let current: Commit | undefined = this.commit(from);
    while (current && out.length < limit) {
      const parent: Commit | undefined = current.parent ? this.commit(current.parent) : undefined;
      if (!sameBytes(current.files.get(path), parent?.files.get(path))) {
        out.push({ commit: current.sha, date: current.date, device: parseCommitDevice(current.message) });
      }
      current = parent;
    }
    return out;
  }

  async isBootstrapCommit(commit: string): Promise<boolean> {
    this.touch();
    const files = [...this.commit(commit).files.keys()];
    return files.length === 1 && files[0] === CONFIG_PATH;
  }

  async hasAnyFiles(commit: string): Promise<boolean> {
    this.touch();
    return this.commit(commit).files.size > 0;
  }

  async initialize(config: PublicVaultConfig, meta: CommitMetadata): Promise<string> {
    this.touch();
    if (this.head) throw new SyncError("ConcurrentRemoteUpdate");
    const sha = this.newSha();
    this.commits.set(sha, { sha, parent: null, files: new Map([[CONFIG_PATH, serializeVaultConfig(config)]]), message: meta.message, date: this.commitDate() });
    this.head = sha;
    this.hasCommits = true;
    return sha;
  }

  async createCommit(parent: string, changes: readonly RemoteChange[], meta: CommitMetadata): Promise<string> {
    this.touch();
    const files = new Map(this.commit(parent).files);
    for (const change of changes) {
      switch (change.kind) {
        case "putObject":
          assertEncrypted(change.blob.bytes);
          files.set(objectPath(change.objectId), change.blob.bytes.slice());
          break;
        case "deleteObject":
          files.delete(objectPath(change.objectId));
          break;
        case "putManifest":
          assertEncrypted(change.blob.bytes);
          files.set(MANIFEST_PATH, change.blob.bytes.slice());
          break;
        case "putConfig":
          files.set(CONFIG_PATH, serializeVaultConfig(change.config));
          break;
      }
    }
    this.crash("afterBlobUpload");
    this.crash("afterTreeCreation");
    const sha = this.newSha();
    this.commits.set(sha, { sha, parent, files, message: meta.message, date: this.commitDate() });
    this.crash("afterCommitCreation");
    return sha;
  }

  async updateHead(expectedParent: string, newCommit: string): Promise<void> {
    this.touch();
    if (this.beforeUpdateHead) {
      const hook = this.beforeUpdateHead;
      this.beforeUpdateHead = null;
      await hook();
    }
    this.crash("beforeRefUpdate");
    if (this.head !== expectedParent) throw new SyncError("ConcurrentRemoteUpdate");
    this.commit(newCommit);
    this.head = newCommit;
    this.crash("afterRefUpdate");
  }

  async getParents(commit: string): Promise<string[]> {
    this.touch();
    const parent = this.commit(commit).parent;
    return parent ? [parent] : [];
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    this.touch();
    let current: string | null = descendant;
    while (current) {
      if (current === ancestor) return true;
      current = this.commits.get(current)?.parent ?? null;
    }
    return false;
  }

  // ── test helpers ──

  /** Everything an attacker with full repository access could see. */
  everythingStored(): Uint8Array[] {
    const out: Uint8Array[] = [];
    const enc = new TextEncoder();
    for (const c of this.commits.values()) {
      out.push(enc.encode(c.message));
      for (const [path, data] of c.files) {
        out.push(enc.encode(path));
        out.push(data);
      }
    }
    return out;
  }

  headFiles(): string[] {
    return this.head ? [...this.commit(this.head).files.keys()].sort() : [];
  }

  forceSetHead(sha: string | null): void {
    this.head = sha;
  }

  parentOf(sha: string): string | null {
    return this.commit(sha).parent;
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
