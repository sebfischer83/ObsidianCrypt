import { describe, expect, it } from "vitest";
import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { RemoteError } from "../src/errors/RemoteError";
import { SyncError } from "../src/errors/SyncError";
import { describeError } from "../src/errors/VaultSyncError";
import { ARMOR_PREFIX, MANIFEST_PATH } from "../src/remote/RemoteLayout";
import { utf8Decode } from "../src/util/bytes";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { crypto, Device } from "./fakes/harness";
import { findLeaks } from "./security.test";

function setup(server = new FakeGitHubServer(), token: string | null = server.token, options: { inlineThreshold?: number } = {}) {
  const sleeps: number[] = [];
  const client = new GitHubClient({
    http: server,
    auth: new PersonalAccessTokenAuth(() => token),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    minWriteIntervalMs: 0,
    random: () => 0.5,
  });
  const api = new GitObjectsApi(client, server.owner, server.repo);
  const remote = new GitHubRemoteRepository(api, { branch: "main", ...options });
  return { server, client, api, remote, sleeps };
}

async function githubDevices(options: { inlineThreshold?: number } = {}) {
  const { server, remote } = setup(new FakeGitHubServer(), undefined, options);
  const a = new Device(remote);
  await a.createVault();
  const b = new Device(remote);
  await b.connect();
  return { server, remote, a, b };
}

describe("GitHub backend end-to-end (emulated API)", () => {
  it("initialises an empty repository and runs the MVP flow", async () => {
    const { server, a, b } = await githubDevices();
    a.fs.setText("Test.md", "Hallo Welt");
    const image = crypto.randomBytes(40_000);
    a.fs.setBytes("Bild.png", image);
    await a.sync();
    await b.sync();
    expect(b.fs.text("Test.md")).toBe("Hallo Welt");
    expect(b.fs.bytes("Bild.png")).toEqual(image);
    b.fs.setText("Test.md", "Hallo Welt 2");
    await b.sync();
    await a.sync();
    expect(a.fs.text("Test.md")).toBe("Hallo Welt 2");
    expect(server.headFiles().every((p) => /^(\.vaultsync\/(config|manifest\.enc)|objects\/[0-9a-f]{2}\/[0-9a-f]{32})$/.test(p))).toBe(true);
  });

  it("batches small objects armoured into tree requests and large ones as blobs", async () => {
    const { server, a } = await githubDevices({ inlineThreshold: 10_000 });
    for (let i = 0; i < 20; i++) a.fs.setText(`n${i}.md`, `note ${i}`);
    a.fs.setBytes("big.bin", crypto.randomBytes(50_000));
    await a.sync();
    const posts = server.requests.filter((r) => r.method === "POST");
    const blobPosts = posts.filter((r) => r.url.endsWith("/git/blobs"));
    const treePosts = posts.filter((r) => r.url.endsWith("/git/trees"));
    expect(blobPosts).toHaveLength(1);
    expect(treePosts.length).toBeLessThanOrEqual(2);
    const manifest = server.headBlob(MANIFEST_PATH) as Uint8Array;
    expect(utf8Decode(manifest.subarray(0, ARMOR_PREFIX.length))).toBe(ARMOR_PREFIX);
  });

  it("nothing sensitive is ever sent to GitHub", async () => {
    const { server, a, b } = await githubDevices({ inlineThreshold: 1000 });
    a.fs.setText("Privat/Meine Passwörter.md", "SuperSecretNote password123");
    a.fs.setText("Kunden/Müller GmbH.md", "Customer Müller");
    a.fs.setBytes("Finanzen/big.pdf", new TextEncoder().encode("Finanzen ".repeat(500)));
    await a.sync();
    await b.sync();
    b.fs.setText("Kunden/Müller GmbH.md", "Customer Müller v2");
    await b.sync();
    expect(findLeaks(server.everything(), ["SuperSecretNote", "password123", "Meine Passwörter", "Privat", "Kunden", "Müller GmbH", "Customer Müller", "Finanzen"])).toEqual([]);
  });

  it("concurrent pushes never overwrite each other (fast-forward only)", async () => {
    const { server, a, b } = await githubDevices();
    a.fs.setText("a.md", "A");
    b.fs.setText("b.md", "B");
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.fs.snapshot()).toEqual({ "a.md": "A", "b.md": "B" });
    expect(server.requests.filter((r) => r.method === "PATCH").every((r) => JSON.parse(r.body as string).force === false)).toBe(true);
  });

  it("a lost ref-update response is resolved by re-reading the branch", async () => {
    const { server, a, b } = await githubDevices();
    a.fs.setText("n.md", "v1");
    server.failures.push({ match: (r) => r.method === "PATCH", networkError: true, afterApply: true });
    await a.sync();
    await b.sync();
    expect(b.fs.text("n.md")).toBe("v1");
  });

  it("refuses to initialise a repository with foreign content", async () => {
    const { server, remote } = setup();
    // Put an unrelated file into the repository via the "empty repo" endpoint.
    await server.request({
      method: "PUT",
      url: `https://api.github.com/repos/${server.owner}/${server.repo}/contents/README.md`,
      headers: { Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ message: "readme", content: btoa("hello"), branch: "main" }),
      timeoutMs: 1000,
    });
    const device = new Device(remote);
    await expect(device.createVault()).rejects.toBeInstanceOf(SyncError);
  });
});

describe("GitHub client behaviour", () => {
  it("retries server errors with exponential backoff", async () => {
    const { server, api, sleeps } = setup();
    for (let i = 0; i < 3; i++) server.failures.push({ match: (r) => r.method === "GET", status: 502 });
    await api.getRepository();
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("gives up after maxRetries network errors with a Network error", async () => {
    const { server, api } = setup();
    for (let i = 0; i < 10; i++) server.failures.push({ match: () => true, networkError: true });
    const error = await api.getRepository().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).category).toBe("Network");
  });

  it("respects secondary rate limits (retry-after)", async () => {
    const { server, api, sleeps } = setup();
    server.failures.push({ match: () => true, status: 403, headers: { "retry-after": "5" } });
    await api.getRepository();
    expect(sleeps).toEqual([5000]);
  });

  it("stops on long primary rate limits instead of hammering the API", async () => {
    const { server, api } = setup();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    server.failures.push({ match: () => true, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    const error = await api.getRepository().catch((e: unknown) => e);
    expect((error as RemoteError).category).toBe("RateLimit");
    expect((error as RemoteError).retryAfterMs).toBeGreaterThan(60_000);
  });

  it("classifies authentication, authorization and missing repositories", async () => {
    const wrongToken = setup(new FakeGitHubServer(), "github_pat_WRONG_TOKEN_abcdef");
    const authError = await wrongToken.remote.getHead().catch((e: unknown) => e);
    expect((authError as RemoteError).category).toBe("Authentication");
    expect(describeError(authError)).not.toContain("github_pat_WRONG_TOKEN_abcdef");

    const missing = setup();
    missing.server.repoExists = false;
    const repoError = await missing.remote.getHead().catch((e: unknown) => e);
    expect((repoError as RemoteError).category).toBe("RepositoryMissing");

    const readonly = await githubDevices();
    readonly.server.canPush = false;
    readonly.a.fs.setText("x.md", "x");
    const pushError = await readonly.a.sync().catch((e: unknown) => e);
    expect((pushError as RemoteError).category).toBe("Authorization");
  });

  it("never puts the token into URLs or error messages", async () => {
    const { server, a } = await githubDevices();
    a.fs.setText("x.md", "x");
    server.failures.push({ match: (r) => r.method === "POST", status: 500 });
    await a.sync();
    expect(server.requests.some((r) => r.url.includes(server.token))).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      expect(new RemoteError("ServerError", status).message).not.toContain(server.token);
    }
  });
});

describe("GitHub eventual consistency", () => {
  it("stale branch reads right after a push are not mistaken for a rollback", async () => {
    const { server, a, b } = await githubDevices();
    server.staleRefReads = 2;
    for (let i = 0; i < 5; i++) a.fs.setText(`n${i}.md`, `v${i}`);
    a.reconfigure({ maxFilesPerCommit: 2 });
    await a.sync(); // several commits in one run
    a.fs.setText("n0.md", "changed");
    await a.sync();
    await a.sync();
    await b.sync();
    expect(b.fs.text("n0.md")).toBe("changed");
    expect(b.fs.paths()).toHaveLength(5);
  });

  it("GET requests ask GitHub not to serve cached responses", async () => {
    const { server, a } = await githubDevices();
    a.fs.setText("x.md", "x");
    await a.sync();
    const gets = server.requests.filter((r) => r.method === "GET");
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((r) => r.headers["Cache-Control"] === "no-cache")).toBe(true);
  });
});
