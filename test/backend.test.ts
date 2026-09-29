import { describe, expect, it } from "vitest";
import { describeLocation, locationKey, parseBackendLocation, sameLocation } from "../src/remote/BackendLocation";
import { credentialSecretId, credentialSecrets, parseCredentials, serializeCredentials } from "../src/remote/Credentials";
import { loadSettings } from "../src/settings";

describe("backend locations", () => {
  it("parses and normalises all backend kinds", () => {
    expect(parseBackendLocation({ kind: "github", owner: "alice", repo: "vault", branch: "main" }, "l")).toEqual({ kind: "github", owner: "alice", repo: "vault", branch: "main" });
    expect(parseBackendLocation({ kind: "s3", endpoint: "https://S3.eu-central-1.amazonaws.com/", region: "eu-central-1", bucket: "my-vault", prefix: "notes/main", pathStyle: false }, "l")).toEqual({
      kind: "s3",
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      bucket: "my-vault",
      prefix: "notes/main",
      pathStyle: false,
    });
    expect(parseBackendLocation({ kind: "webdav", url: "https://cloud.example.org/remote.php/dav/files/me/Vault" }, "l")).toEqual({ kind: "webdav", url: "https://cloud.example.org/remote.php/dav/files/me/Vault/" });
    expect(parseBackendLocation({ kind: "webdav", url: "http://localhost:8080/dav" }, "l")).toMatchObject({ url: "http://localhost:8080/dav/" });
    // Before format 5 GitHub locations had no kind.
    expect(parseBackendLocation({ owner: "alice", repo: "vault", branch: "main" }, "l", true)).toMatchObject({ kind: "github" });
  });

  it("rejects anything that could leak credentials or address something else", () => {
    const bad: unknown[] = [
      { owner: "alice", repo: "vault", branch: "main" },
      { kind: "github", owner: "-x", repo: "vault", branch: "main" },
      { kind: "github", owner: "alice", repo: "..", branch: "main" },
      { kind: "webdav", url: "http://cloud.example.org/dav" },
      { kind: "webdav", url: "https://user:pw@cloud.example.org/dav" },
      { kind: "webdav", url: "https://cloud.example.org/dav?x=1" },
      { kind: "webdav", url: "https://cloud.example.org/a/../b" },
      { kind: "webdav", url: "ftp://cloud.example.org/dav" },
      { kind: "s3", endpoint: "https://s3.example.com/path", region: "us-east-1", bucket: "bucket", prefix: "", pathStyle: true },
      { kind: "s3", endpoint: "https://s3.example.com", region: "us-east-1", bucket: "Bucket", prefix: "", pathStyle: true },
      { kind: "s3", endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bucket", prefix: "/a", pathStyle: true },
      { kind: "s3", endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bucket", prefix: "a/../b", pathStyle: true },
      { kind: "s3", endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bucket", prefix: "", pathStyle: true, extra: 1 },
      { kind: "ftp", url: "x" },
    ];
    for (const value of bad) expect(() => parseBackendLocation(value, "l"), JSON.stringify(value)).toThrow();
  });

  it("identifies locations canonically", () => {
    const a = parseBackendLocation({ kind: "github", owner: "Alice", repo: "Vault", branch: "main" }, "l");
    const b = parseBackendLocation({ kind: "github", owner: "alice", repo: "vault", branch: "main" }, "l");
    expect(sameLocation(a, b)).toBe(true);
    const c = parseBackendLocation({ kind: "webdav", url: "https://HOST.example.org/dav" }, "l");
    const d = parseBackendLocation({ kind: "webdav", url: "https://host.example.org/dav/" }, "l");
    expect(locationKey(c)).toBe(locationKey(d));
    expect(sameLocation(a, c)).toBe(false);
    expect(describeLocation(a)).toBe("GitHub Alice/Vault (branch main)");
  });
});

describe("credentials and settings", () => {
  it("round-trips credentials and exposes their secrets for redaction", () => {
    const s3 = { kind: "s3", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "very-secret-key" } as const;
    expect(parseCredentials(serializeCredentials(s3), "s3")).toEqual(s3);
    expect(credentialSecrets(s3)).toEqual(["very-secret-key"]);
    expect(() => parseCredentials(serializeCredentials(s3), "webdav")).toThrow();
    expect(() => parseCredentials(JSON.stringify({ kind: "webdav", username: "me", password: " " }), "webdav")).toThrow();
    const location = parseBackendLocation({ kind: "github", owner: "alice", repo: "vault", branch: "main" }, "l");
    expect(credentialSecretId(location)).toMatch(/^egsync-cred-[0-9a-f]{16}$/);
  });

  it("migrates the GitHub fields of older settings and drops invalid locations", () => {
    expect(loadSettings({ owner: "alice", repo: "vault", branch: "dev" }).location).toEqual({ kind: "github", owner: "alice", repo: "vault", branch: "dev" });
    expect(loadSettings({ location: { kind: "webdav", url: "http://evil.example.org" } }).location).toBeNull();
    expect(loadSettings({}).location).toBeNull();
  });
});
