import type { PasswordKdfAlgorithm } from "./crypto/KeyDerivation";
import { DEFAULT_LIMITS, HARD_MAX_FILE_SIZE } from "./sync/SyncEngine";
import type { TriggerSettings } from "./sync/SyncController";
import { isRecord } from "./util/validate";

/**
 * Plugin settings stored in data.json. MUST NOT contain secrets (token, password, keys): those live in
 * the SecretStore only.
 */
export interface PluginSettings extends TriggerSettings {
  owner: string;
  repo: string;
  branch: string;
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
  /** Keep the vault master key in the OS keychain so syncing works without re-entering the password. */
  rememberKey: boolean;
  kdfForNewVaults: PasswordKdfAlgorithm;
  debugLogging: boolean;
  /** Only with explicit consent: include file paths in debug logs. */
  logPaths: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  owner: "",
  repo: "",
  branch: "main",
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
    const value = raw[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as unknown as Record<string, unknown>)[key] = value;
  }
  settings.debounceSeconds = clamp(settings.debounceSeconds, 5, 3600);
  settings.intervalMinutes = settings.intervalMinutes === 0 ? 0 : clamp(settings.intervalMinutes, 1, 60);
  settings.maxFileSizeMB = clamp(settings.maxFileSizeMB, 1, MAX_FILE_SIZE_MB_LIMIT);
  if (settings.kdfForNewVaults !== "argon2id" && settings.kdfForNewVaults !== "pbkdf2-sha256") settings.kdfForNewVaults = "argon2id";
  return settings;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
