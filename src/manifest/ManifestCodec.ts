import { SyncError } from "../errors/SyncError";
import { utf8Decode, utf8Encode } from "../util/bytes";
import { canonicalJson } from "../util/canonicalJson";
import {
  expectInteger,
  expectLiteral,
  expectOnlyKeys,
  expectRecord,
  expectString,
  GIT_SHA,
  HEX_32,
  HEX_64,
  isRecord,
  ValidationError,
} from "../util/validate";
import { isValidVaultPath, pathKey } from "../vault/PathUtils";
import { MANIFEST_TYPE, type Manifest, type ManifestEntry } from "./Manifest";
import { SUPPORTED_FORMAT_VERSION } from "./VaultConfig";

export const MAX_MANIFEST_ENTRIES = 1_000_000;
const DEVICE_ID = /^[0-9a-f-]{8,64}$/;

/** Deterministic serialisation (canonical JSON). */
export function encodeManifest(manifest: Manifest): Uint8Array {
  return utf8Encode(canonicalJson(manifest));
}

/**
 * Strictly parses a decrypted manifest. Any structural problem results in SyncError(Blocked):
 * a manifest that can not be fully trusted is never partially applied.
 */
export function decodeManifest(bytes: Uint8Array, expectedVaultId: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes));
  } catch (error: unknown) {
    throw SyncError.blocked("ManifestCorrupted", { cause: error });
  }
  try {
    return parseManifestObject(raw, expectedVaultId);
  } catch (error: unknown) {
    if (error instanceof SyncError) throw error;
    throw SyncError.blocked("ManifestCorrupted", { cause: error });
  }
}

export function parseManifestObject(raw: unknown, expectedVaultId: string): Manifest {
  const record = expectRecord(raw, "manifest");
  expectLiteral(record.type, MANIFEST_TYPE, "manifest.type");
  const formatVersion = expectInteger(record.formatVersion, "manifest.formatVersion", 1);
  if (formatVersion > SUPPORTED_FORMAT_VERSION) throw SyncError.blocked("UnknownFormatVersion");
  expectOnlyKeys(record, ["type", "formatVersion", "vaultId", "version", "parentCommit", "device", "updatedAt", "entries"], "manifest");
  const vaultId = expectString(record.vaultId, "manifest.vaultId", HEX_32);
  if (vaultId !== expectedVaultId) throw SyncError.blocked("ForeignVault");
  const parentCommit = record.parentCommit === null ? null : expectString(record.parentCommit, "manifest.parentCommit", GIT_SHA);
  const entriesRaw = expectRecord(record.entries, "manifest.entries");
  const ids = Object.keys(entriesRaw);
  if (ids.length > MAX_MANIFEST_ENTRIES) throw new ValidationError("manifest.entries", "too many entries");

  const entries: Record<string, ManifestEntry> = {};
  const seenPaths = new Set<string>();
  for (const id of ids) {
    if (!HEX_32.test(id)) throw new ValidationError("manifest.entries", "invalid object id");
    const entry = parseEntry(entriesRaw[id], `manifest.entries.${id}`);
    if (!("deleted" in entry)) {
      const key = pathKey(entry.path);
      if (seenPaths.has(key)) throw new ValidationError("manifest.entries", "duplicate path");
      seenPaths.add(key);
    }
    entries[id] = entry;
  }

  return {
    type: MANIFEST_TYPE,
    formatVersion,
    vaultId,
    version: expectInteger(record.version, "manifest.version", 0),
    parentCommit,
    device: expectString(record.device, "manifest.device", DEVICE_ID),
    updatedAt: expectInteger(record.updatedAt, "manifest.updatedAt", 0),
    entries,
  };
}

/** Parses a record of entries without cross-entry checks (used for the per-object merge base). */
export function parseManifestEntries(value: unknown, field: string): Record<string, ManifestEntry> {
  const record = expectRecord(value, field);
  const out: Record<string, ManifestEntry> = {};
  for (const [id, entry] of Object.entries(record)) {
    if (!HEX_32.test(id)) throw new ValidationError(field, "invalid object id");
    out[id] = parseEntry(entry, `${field}.${id}`);
  }
  return out;
}

function parseEntry(value: unknown, field: string): ManifestEntry {
  if (!isRecord(value)) throw new ValidationError(field, "expected object");
  if ("deleted" in value) {
    expectOnlyKeys(value, ["deleted", "deletedAtVersion", "deletedBy"], field);
    expectLiteral(value.deleted, true, `${field}.deleted`);
    return {
      deleted: true,
      deletedAtVersion: expectInteger(value.deletedAtVersion, `${field}.deletedAtVersion`, 0),
      deletedBy: expectString(value.deletedBy, `${field}.deletedBy`, DEVICE_ID),
    };
  }
  expectOnlyKeys(value, ["path", "size", "contentHash", "modified", "updatedAtVersion", "updatedBy"], field);
  const path = expectString(value.path, `${field}.path`);
  if (!isValidVaultPath(path)) throw new ValidationError(`${field}.path`, "invalid path");
  return {
    path,
    size: expectInteger(value.size, `${field}.size`, 0),
    contentHash: expectString(value.contentHash, `${field}.contentHash`, HEX_64),
    modified: expectInteger(value.modified, `${field}.modified`, 0),
    updatedAtVersion: expectInteger(value.updatedAtVersion, `${field}.updatedAtVersion`, 0),
    updatedBy: expectString(value.updatedBy, `${field}.updatedBy`, DEVICE_ID),
  };
}
