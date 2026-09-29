import { expectRecord, expectString, isRecord, ValidationError } from "../util/validate";
import { locationKey, type BackendKind, type BackendLocation } from "./BackendLocation";

/** Secrets needed to access a location. Only ever kept in the SecretStore (OS keychain) or in memory. */
export type Credentials =
  | { readonly kind: "github"; readonly token: string }
  | { readonly kind: "s3"; readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
  | { readonly kind: "webdav"; readonly username: string; readonly password: string };

export type CredentialsFor<K extends BackendKind> = Extract<Credentials, { kind: K }>;

export function serializeCredentials(c: Credentials): string {
  return JSON.stringify(c);
}

/** @throws ValidationError */
export function parseCredentials(raw: string, kind: BackendKind): Credentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError("credentials", "not JSON");
  }
  const r = expectRecord(value, "credentials");
  if (r.kind !== kind) throw new ValidationError("credentials.kind", "does not match the backend");
  switch (kind) {
    case "github":
      return { kind, token: nonEmpty(r.token, "token") };
    case "s3":
      return {
        kind,
        accessKeyId: nonEmpty(r.accessKeyId, "accessKeyId"),
        secretAccessKey: nonEmpty(r.secretAccessKey, "secretAccessKey"),
        ...(typeof r.sessionToken === "string" && r.sessionToken ? { sessionToken: r.sessionToken } : {}),
      };
    case "webdav":
      return { kind, username: nonEmpty(r.username, "username"), password: nonEmpty(r.password, "password") };
  }
}

/** The secret values of credentials (for redacting them from any diagnostic text). */
export function credentialSecrets(c: Credentials | null): string[] {
  if (!c) return [];
  switch (c.kind) {
    case "github":
      return [c.token];
    case "s3":
      return [c.secretAccessKey, ...(c.sessionToken ? [c.sessionToken] : [])];
    case "webdav":
      return [c.password];
  }
}

/** SecretStore id for a location's credentials (derived from its canonical key; ids must be `[a-z0-9-]`). */
export function credentialSecretId(location: BackendLocation): string {
  return `egsync-cred-${fnv1a64(locationKey(location))}`;
}

function nonEmpty(value: unknown, field: string): string {
  const s = expectString(value, `credentials.${field}`);
  if (s.trim() === "") throw new ValidationError(`credentials.${field}`, "empty");
  return s.trim();
}

/** Non-cryptographic 64-bit FNV-1a as 16 hex digits (only used to derive a stable id). */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function isCredentials(value: unknown): value is Credentials {
  return isRecord(value) && (value.kind === "github" || value.kind === "s3" || value.kind === "webdav");
}
