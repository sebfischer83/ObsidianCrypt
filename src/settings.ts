import type { PasswordKdfAlgorithm } from "./crypto/KeyDerivation";
import { DEFAULT_LIMITS, HARD_MAX_FILE_SIZE } from "./sync/SyncEngine";
import type { TriggerSettings } from "./sync/SyncController";
import { MAX_VERSION_LIMIT } from "./sync/VersionHistory";
import { isRecord } from "./util/validate";
import { parseBackendLocation, type BackendLocation } from "./remote/BackendLocation";

/**
 * Plugin settings stored in data.json. MUST NOT contain secrets (token, password, keys): those live in
 * the SecretStore only.
 */
export interface PluginSettings extends TriggerSettings {
  /** Where the vault is stored (GitHub repository, S3 bucket/prefix, WebDAV folder); null = not set up. */
  location: BackendLocation | null;
  autoSync: boolean;
  syncOnStartup: boolean;
  syncOnResume: boolean;
  syncAfterChanges: boolean;
  debounceSeconds: number;
  intervalMinutes: number;
  syncConfigDir: boolean;
  syncCoreSettings: boolean;
  syncPlugins: boolean;
  syncThemesAndSnippets: boolean;
  syncWorkspace: boolean;
  maxFileSizeMB: number;
  /** How many earlier versions the version history lists per file. */
  versionHistoryLimit: number;
  /** Marks unsynchronised, conflicting, skipped and excluded files in the file explorer. */
  showExplorerStatus: boolean;
  /** Keep the vault master key in the OS keychain so syncing works without re-entering the password. */
  rememberKey: boolean;
  kdfForNewVaults: PasswordKdfAlgorithm;
  debugLogging: boolean;
  /** Only with explicit consent: include file paths in debug logs. */
  logPaths: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  location: null,
  autoSync: true,
  syncOnStartup: true,
  syncOnResume: true,
  syncAfterChanges: true,
  debounceSeconds: 30,
  intervalMinutes: 0,
  syncConfigDir: true,
  syncCoreSettings: true,
  syncPlugins: false,
  syncThemesAndSnippets: false,
  syncWorkspace: false,
  maxFileSizeMB: DEFAULT_LIMITS.maxFileSize / (1024 * 1024),
  versionHistoryLimit: 20,
  showExplorerStatus: true,
  rememberKey: true,
  kdfForNewVaults: "argon2id",
  debugLogging: false,
  logPaths: false,
};

export const MAX_FILE_SIZE_MB_LIMIT = Math.floor(HARD_MAX_FILE_SIZE / (1024 * 1024));

/** Merges stored data with defaults, keeping only known keys of the right type (drops anything else). */
export function loadSettings(raw: unknown): PluginSettings {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return settings;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PluginSettings>) {
    if (key === "location") continue;
    const value = raw[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value;
  }
  settings.location = loadLocation(raw);
  settings.debounceSeconds = clamp(settings.debounceSeconds, 5, 3600);
  settings.intervalMinutes = settings.intervalMinutes === 0 ? 0 : clamp(settings.intervalMinutes, 1, 60);
  settings.maxFileSizeMB = clamp(settings.maxFileSizeMB, 1, MAX_FILE_SIZE_MB_LIMIT);
  settings.versionHistoryLimit = clamp(settings.versionHistoryLimit, 1, MAX_VERSION_LIMIT);
  if (settings.kdfForNewVaults !== "argon2id" && settings.kdfForNewVaults !== "pbkdf2-sha256") settings.kdfForNewVaults = "argon2id";
  return settings;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The stored location, strictly validated; settings of 0.4 and earlier stored a GitHub owner/repo/branch. */
function loadLocation(raw: Record<string, unknown>): BackendLocation | null {
  try {
    if (raw.location !== undefined && raw.location !== null) return parseBackendLocation(raw.location, "settings.location");
    if (typeof raw.owner === "string" && raw.owner && typeof raw.repo === "string" && raw.repo) {
      return parseBackendLocation({ kind: "github", owner: raw.owner, repo: raw.repo, branch: typeof raw.branch === "string" && raw.branch ? raw.branch : "main" }, "settings");
    }
  } catch {
    // An invalid stored location is treated as "not set up" (never guessed).
  }
  return null;
}
