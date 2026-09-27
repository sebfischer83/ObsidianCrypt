import { sha256 } from "@noble/hashes/sha2.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../../src/github/HttpClient";
import { fromBase64, toHex, utf8Decode, utf8Encode } from "../../src/util/bytes";

interface CommitObject {
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
  readonly date: number;
}

export interface InjectedFailure {
  readonly match: (req: HttpRequest) => boolean;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly networkError?: boolean;
  /** Apply the request first, then fail (simulates a lost response). */
  readonly afterApply?: boolean;
}

/**
 * Minimal emulator of the GitHub REST endpoints used by the plugin, backed by an in-memory git object
 * store. Records every request so tests can prove nothing sensitive is ever sent.
 */
export class FakeGitHubServer implements HttpClient {
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, CommitObject>();
  readonly refs = new Map<string, string>();
  readonly requests: HttpRequest[] = [];
  readonly failures: InjectedFailure[] = [];
  repoExists = true;
  /** Eventual consistency: after a ref update, this many ref reads still return the previous commit. */
  staleRefReads = 0;
  private stale = new Map<string, { sha: string; remaining: number }>();
  canPush = true;

  constructor(
    readonly owner = "alice",
    readonly repo = "vault",
    readonly token = "github_pat_TESTTOKEN_1234567890",
  ) {}

  private json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse {
    return { status, headers: { "content-type": "application/json", ...headers }, body: utf8Encode(JSON.stringify(value)) };
  }

  private hash(kind: string, data: Uint8Array): string {
    return toHex(sha256(new Uint8Array([...utf8Encode(`${kind} ${data.length}\0`), ...data]))).slice(0, 40);
  }

  /** Commit timestamps: one minute apart, deterministic. */
  private commitDate(): number {
    return 1_790_000_000_000 + this.commits.size * 60_000;
  }

  private putBlob(data: Uint8Array): string {
    const sha = this.hash("blob", data);
    this.blobs.set(sha, data.slice());
    return sha;
  }

  private putTree(files: Map<string, string>): string {
    const sha = this.hash("tree", utf8Encode(JSON.stringify([...files].sort())));
    this.trees.set(sha, new Map(files));
    return sha;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const failureIndex = this.failures.findIndex((f) => f.match(req));
    const failure = failureIndex >= 0 ? this.failures.splice(failureIndex, 1)[0] : undefined;
    if (failure && !failure.afterApply) {
      if (failure.networkError) throw new Error("ECONNRESET");
      return this.json(failure.status ?? 500, { message: "injected" }, failure.headers);
    }
    const response = this.handle(req);
    if (failure?.afterApply) {
      if (failure.networkError) throw new Error("ECONNRESET");
      return this.json(failure.status ?? 500, { message: "injected" }, failure.headers);
    }
    return response;
  }

  private handle(req: HttpRequest): HttpResponse {
    if (req.headers.Authorization !== `Bearer ${this.token}`) return this.json(401, { message: "Bad credentials" });
    const url = new URL(req.url);
    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!url.pathname.startsWith(prefix) || !this.repoExists) return this.json(404, { message: "Not Found" });
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const empty = this.commits.size === 0;
    if (req.method !== "GET" && !this.canPush) return this.json(403, { message: "Resource not accessible by personal access token" });

    if (req.method === "GET" && path === "") {
      return this.json(200, { private: true, default_branch: "main", permissions: { push: this.canPush, admin: false } });
    }
    if (req.method === "GET" && path === "/branches") return this.json(200, [...this.refs.keys()].map((name) => ({ name })));

    let m: RegExpMatchArray | null;
    if (req.method === "GET" && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      if (empty) return this.json(409, { message: "Git Repository is empty." });
      const lagging = this.stale.get(m[1] as string);
      if (lagging && lagging.remaining > 0) {
        lagging.remaining--;
        return this.json(200, { ref: `refs/heads/${m[1]}`, object: { sha: lagging.sha, type: "commit" } });
      }
      const sha = this.refs.get(m[1] as string);
      return sha ? this.json(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : this.json(404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = this.commits.get(m[1] as string);
      return c ? this.json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : this.json(404, {});
    }
    if (req.method === "GET" && (m = path.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const files = this.trees.get(m[1] as string);
      if (!files) return this.json(404, {});
      const recursive = url.searchParams.get("recursive") === "1";
      const entries = new Map<string, { path: string; type: string; sha: string }>();
      for (const [p, sha] of files) {
        const parts = p.split("/");
        if (!recursive) {
          const top = parts[0] as string;
          entries.set(top, { path: top, type: parts.length > 1 ? "tree" : "blob", sha: parts.length > 1 ? "0".repeat(40) : sha });
          continue;
        }
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join("/");
          entries.set(dir, { path: dir, type: "tree", sha: "0".repeat(40) });
        }
        entries.set(p, { path: p, type: "blob", sha });
      }
      return this.json(200, { sha: m[1], truncated: false, tree: [...entries.values()] });
    }
    if (req.method === "GET" && (m = path.match(/^\/contents\/(.+)$/))) {
      const ref = url.searchParams.get("ref") ?? "";
      const commit = this.commits.get(ref) ?? this.commits.get(this.refs.get(ref) ?? "");
      const blobSha = commit ? this.trees.get(commit.tree)?.get(m[1] as string) : undefined;
      if (!blobSha) return this.json(404, { message: "Not Found" });
      return { status: 200, headers: {}, body: (this.blobs.get(blobSha) as Uint8Array).slice() };
    }
    if (req.method === "GET" && path === "/commits") {
      // History of one path along first parents (our history is linear), newest first.
      const start = url.searchParams.get("sha") ?? "";
      const filePath = url.searchParams.get("path") ?? "";
      const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? "30"));
      let sha: string | undefined = this.commits.has(start) ? start : this.refs.get(start);
      if (!sha) return this.json(404, { message: "Not Found" });
      const out: unknown[] = [];
      while (sha && out.length < perPage) {
        const c = this.commits.get(sha) as CommitObject;
        const parent = c.parents[0];
        const before = parent ? this.trees.get((this.commits.get(parent) as CommitObject).tree)?.get(filePath) : undefined;
        if (this.trees.get(c.tree)?.get(filePath) !== before) {
          out.push({ sha, commit: { message: c.message, committer: { date: new Date(c.date).toISOString() } }, parents: c.parents.map((p) => ({ sha: p })) });
        }
        sha = parent;
      }
      return this.json(200, out);
    }
    if (req.method === "GET" && (m = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const [base, head] = [m[1] as string, m[2] as string];
      if (!this.commits.has(base) || !this.commits.has(head)) return this.json(404, {});
      if (base === head) return this.json(200, { status: "identical" });
      if (this.isAncestor(base, head)) return this.json(200, { status: "ahead" });
      if (this.isAncestor(head, base)) return this.json(200, { status: "behind" });
      return this.json(200, { status: "diverged" });
    }

    if (req.method === "PUT" && (m = path.match(/^\/contents\/(.+)$/))) {
      if (!empty) return this.json(422, { message: "sha wasn't supplied" });
      const blob = this.putBlob(fromBase64(body.content as string));
      const tree = this.putTree(new Map([[m[1] as string, blob]]));
      const sha = this.hash("commit", utf8Encode(`${tree}|${String(body.message)}|root`));
      this.commits.set(sha, { tree, parents: [], message: String(body.message), date: this.commitDate() });
      this.refs.set((body.branch as string) ?? "main", sha);
      return this.json(201, { commit: { sha } });
    }
    if (empty && req.method === "POST" && path.startsWith("/git/")) return this.json(409, { message: "Git Repository is empty." });
    if (req.method === "POST" && path === "/git/blobs") {
      if (body.encoding !== "base64") return this.json(422, {});
      return this.json(201, { sha: this.putBlob(fromBase64(body.content as string)) });
    }
    if (req.method === "POST" && path === "/git/trees") {
      const base = typeof body.base_tree === "string" ? this.trees.get(body.base_tree) : new Map<string, string>();
      if (!base) return this.json(422, { message: "base_tree not found" });
      const files = new Map(base);
      for (const entry of body.tree as Array<Record<string, unknown>>) {
        const p = entry.path as string;
        if (entry.sha === null) {
          if (!files.has(p)) return this.json(422, { message: "path not found" });
          files.delete(p);
        } else if (typeof entry.content === "string") files.set(p, this.putBlob(utf8Encode(entry.content)));
        else if (typeof entry.sha === "string" && this.blobs.has(entry.sha)) files.set(p, entry.sha);
        else return this.json(422, { message: "invalid tree entry" });
      }
      return this.json(201, { sha: this.putTree(files) });
    }
    if (req.method === "POST" && path === "/git/commits") {
      const tree = body.tree as string;
      const parents = body.parents as string[];
      if (!this.trees.has(tree) || parents.some((p) => !this.commits.has(p))) return this.json(422, {});
      const sha = this.hash("commit", utf8Encode(`${tree}|${parents.join(",")}|${String(body.message)}|${this.commits.size}`));
      this.commits.set(sha, { tree, parents, message: String(body.message), date: this.commitDate() });
      return this.json(201, { sha });
    }
    if (req.method === "POST" && path === "/git/refs") {
      const ref = (body.ref as string).replace(/^refs\/heads\//, "");
      if (this.refs.has(ref)) return this.json(422, { message: "Reference already exists" });
      this.refs.set(ref, body.sha as string);
      return this.json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (req.method === "PATCH" && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const branch = m[1] as string;
      const current = this.refs.get(branch);
      if (!current) return this.json(422, { message: "Reference does not exist" });
      const target = body.sha as string;
      if (body.force !== false) throw new Error("plugin must never force-push");
      if (!this.isAncestor(current, target)) return this.json(422, { message: "Update is not a fast forward" });
      if (this.staleRefReads > 0) this.stale.set(branch, { sha: current, remaining: this.staleRefReads });
      this.refs.set(branch, target);
      return this.json(200, { object: { sha: target } });
    }
    return this.json(404, { message: `unhandled ${req.method} ${path}` });
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const queue = [descendant];
    const seen = new Set<string>();
    while (queue.length) {
      const sha = queue.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  /** Everything the server ever received or stores (for leak scanning). */
  everything(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const r of this.requests) {
      out.push(utf8Encode(r.url));
      if (r.body) out.push(utf8Encode(r.body));
    }
    for (const b of this.blobs.values()) out.push(b);
    for (const c of this.commits.values()) out.push(utf8Encode(c.message));
    for (const t of this.trees.values()) out.push(utf8Encode([...t.keys()].join("\n")));
    return out;
  }

  headFiles(branch = "main"): string[] {
    const sha = this.refs.get(branch);
    const commit = sha ? this.commits.get(sha) : undefined;
    return commit ? [...(this.trees.get(commit.tree)?.keys() ?? [])].sort() : [];
  }

  headBlob(path: string, branch = "main"): Uint8Array | null {
    const sha = this.refs.get(branch);
    const commit = sha ? this.commits.get(sha) : undefined;
    const blob = commit ? this.trees.get(commit.tree)?.get(path) : undefined;
    return blob ? (this.blobs.get(blob) ?? null) : null;
  }

  text(data: Uint8Array): string {
    return utf8Decode(data);
  }
}
