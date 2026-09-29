import { expectBoolean, expectOnlyKeys, expectRecord, expectString, GIT_SHA, ValidationError } from "../util/validate";

/**
 * Where a vault is stored. Stored in the settings and – for moved vaults – inside the encrypted manifest
 * (`movedTo` / `movedFrom`), so every field is validated strictly: locations are used to build request URLs.
 * Credentials are never part of a location.
 */

export type BackendKind = "github" | "s3" | "webdav";

export interface GitHubLocation {
  readonly kind: "github";
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

export interface S3Location {
  readonly kind: "s3";
  /** Origin of the S3 API, e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Key prefix without leading/trailing slash ("" = bucket root). */
  readonly prefix: string;
  /** Path-style addressing (endpoint/bucket/key) instead of virtual-hosted style (bucket.endpoint/key). */
  readonly pathStyle: boolean;
}

export interface WebDavLocation {
  readonly kind: "webdav";
  /** Folder URL, normalised with a trailing slash. */
  readonly url: string;
}

export type BackendLocation = GitHubLocation | S3Location | WebDavLocation;

/** An earlier location of a moved vault, readable up to `commit`. */
export type ArchivedLocation = BackendLocation & { readonly commit: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,250}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parses a location. `legacy` accepts the pre-format-5 shape `{owner, repo, branch}` (GitHub without `kind`).
 * @throws ValidationError
 */
export function parseBackendLocation(value: unknown, field: string, legacy = false): BackendLocation {
  const r = expectRecord(value, field);
  if (r.kind === undefined && legacy) return parseGitHub({ ...r, kind: "github" }, field);
  switch (r.kind) {
    case "github":
      return parseGitHub(r, field);
    case "s3": {
      expectOnlyKeys(r, ["kind", "endpoint", "region", "bucket", "prefix", "pathStyle"], field);
      const endpoint = normaliseUrl(expectString(r.endpoint, `${field}.endpoint`), `${field}.endpoint`, true);
      const prefix = expectString(r.prefix, `${field}.prefix`);
      if (prefix !== "" && (prefix.length > 256 || !prefix.split("/").every((s) => PREFIX_SEGMENT.test(s) && s !== "." && s !== ".."))) {
        throw new ValidationError(`${field}.prefix`, "invalid prefix");
      }
      const bucket = expectString(r.bucket, `${field}.bucket`, BUCKET);
      if (bucket.includes("..")) throw new ValidationError(`${field}.bucket`, "invalid bucket");
      return { kind: "s3", endpoint, region: expectString(r.region, `${field}.region`, REGION), bucket, prefix, pathStyle: expectBoolean(r.pathStyle, `${field}.pathStyle`) };
    }
    case "webdav":
      expectOnlyKeys(r, ["kind", "url"], field);
      return { kind: "webdav", url: normaliseUrl(expectString(r.url, `${field}.url`), `${field}.url`, false) };
    default:
      throw new ValidationError(`${field}.kind`, "unknown backend");
  }
}

export function parseArchivedLocation(value: unknown, field: string, legacy = false): ArchivedLocation {
  const r = expectRecord(value, field);
  const { commit, ...rest } = r;
  return { ...parseBackendLocation(rest, field, legacy), commit: expectString(commit, `${field}.commit`, GIT_SHA) };
}

function parseGitHub(r: Record<string, unknown>, field: string): GitHubLocation {
  expectOnlyKeys(r, ["kind", "owner", "repo", "branch"], field);
  const owner = expectString(r.owner, `${field}.owner`, OWNER);
  const repo = expectString(r.repo, `${field}.repo`, REPO);
  const branch = expectString(r.branch, `${field}.branch`, BRANCH);
  if (repo === "." || repo === ".." || branch.includes("..")) throw new ValidationError(field, "invalid location");
  return { kind: "github", owner, repo, branch };
}

/**
 * https only (plain http only for this machine: credentials would travel in clear text otherwise); no
 * credentials, query or fragment. `originOnly` requires an empty path (S3 endpoints).
 */
export function normaliseUrl(raw: string, field: string, originOnly: boolean): string {
  // Dot segments would be resolved silently by URL parsing; refuse them so a location means exactly what it says.
  const path = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  if (path.split(/[/?#]/).some((segment) => segment === "." || segment === "..")) throw new ValidationError(field, "invalid path");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError(field, "invalid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) throw new ValidationError(field, "https required");
  if (url.username || url.password || url.search || url.hash) throw new ValidationError(field, "URL must not contain credentials, query or fragment");
  if (originOnly) {
    if (url.pathname !== "/" && url.pathname !== "") throw new ValidationError(field, "endpoint must not contain a path");
    return url.origin;
  }
  if (url.pathname.split("/").some((s) => s === "." || s === "..")) throw new ValidationError(field, "invalid path");
  return url.origin + (url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
}

/** Canonical identity of a location (case-insensitive where the backend is). */
export function locationKey(l: BackendLocation): string {
  switch (l.kind) {
    case "github":
      return `github:${l.owner.toLowerCase()}/${l.repo.toLowerCase()}#${l.branch}`;
    case "s3":
      return `s3:${l.endpoint.toLowerCase()}/${l.bucket}/${l.prefix}`;
    case "webdav": {
      const url = new URL(l.url);
      return `webdav:${url.origin.toLowerCase()}${url.pathname}`;
    }
  }
}

export function sameLocation(a: BackendLocation, b: BackendLocation): boolean {
  return locationKey(a) === locationKey(b);
}

/** Short human readable description (UI, activity log). */
export function describeLocation(l: BackendLocation): string {
  switch (l.kind) {
    case "github":
      return `GitHub ${l.owner}/${l.repo} (branch ${l.branch})`;
    case "s3":
      return `S3 ${l.bucket}${l.prefix ? `/${l.prefix}` : ""} at ${new URL(l.endpoint).host}`;
    case "webdav":
      return `WebDAV ${l.url}`;
  }
}

/** The location without anything but its own fields (e.g. strips `commit` / `markerCommit`). */
export function toLocation(l: BackendLocation): BackendLocation {
  switch (l.kind) {
    case "github":
      return { kind: "github", owner: l.owner, repo: l.repo, branch: l.branch };
    case "s3":
      return { kind: "s3", endpoint: l.endpoint, region: l.region, bucket: l.bucket, prefix: l.prefix, pathStyle: l.pathStyle };
    case "webdav":
      return { kind: "webdav", url: l.url };
  }
}
