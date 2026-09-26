import type { ListFilter } from "./LocalFileSystem";
import { IgnoreMatcher } from "./IgnoreMatcher";

export const IGNORE_FILE = ".vaultsyncignore";
export const TEMP_SUFFIX = ".vaultsync-tmp";

export const DEFAULT_IGNORE_RULES = [".trash/", "*.tmp", ".DS_Store", "Thumbs.db", "desktop.ini"];

/** Files of the Obsidian config folder synchronised with "core settings". */
export const CORE_CONFIG_FILES = ["app.json", "appearance.json", "hotkeys.json", "core-plugins.json"];
export const WORKSPACE_FILES = ["workspace.json", "workspace-mobile.json", "workspaces.json"];

export interface FilterSettings {
  /** Obsidian config folder, normally ".obsidian" (vault.configDir). */
  readonly configDir: string;
  /** Own plugin id: its folder (settings, local state) is never synchronised. */
  readonly pluginId: string;
  readonly syncConfigDir: boolean;
  readonly syncCoreSettings: boolean;
  readonly syncPlugins: boolean;
  readonly syncThemesAndSnippets: boolean;
  readonly syncWorkspace: boolean;
}

/**
 * Decides which vault paths take part in synchronisation. Applied BEFORE encryption. Paths excluded here
 * are never uploaded and — importantly — never treated as "deleted" either.
 */
export class SyncFilter implements ListFilter {
  private readonly ownPluginDir: string;

  constructor(
    private readonly settings: FilterSettings,
    private readonly ignore: IgnoreMatcher = new IgnoreMatcher(DEFAULT_IGNORE_RULES),
  ) {
    this.ownPluginDir = `${settings.configDir}/plugins/${settings.pluginId}`;
  }

  includes(path: string): boolean {
    if (!isPortablePath(path)) return false;
    if (!this.passesStructuralRules(path)) return false;
    if (path === IGNORE_FILE) return true;
    return !this.ignore.isIgnored(path);
  }

  shouldDescend(folderPath: string): boolean {
    if (this.isOwnPluginPath(folderPath)) return false;
    const segments = folderPath.split("/");
    if (segments.includes(".git")) return false;
    const configDir = this.settings.configDir;
    if (folderPath === configDir || folderPath.startsWith(`${configDir}/`)) {
      if (!this.settings.syncConfigDir) return false;
      const rel = folderPath === configDir ? "" : folderPath.slice(configDir.length + 1);
      if (rel === "") return true;
      const top = rel.split("/")[0];
      if (top === "plugins") return this.settings.syncPlugins;
      if (top === "themes" || top === "snippets") return this.settings.syncThemesAndSnippets;
      return false;
    }
    if (segments.some((s) => s.startsWith("."))) return false;
    return !this.ignore.isFolderIgnored(folderPath);
  }

  /** Hidden roots the file system must list explicitly (Obsidian's file index skips dot-folders). */
  hiddenRoots(): string[] {
    return this.settings.syncConfigDir ? [this.settings.configDir] : [];
  }

  /** Case-insensitive: on Windows/macOS/iOS ".Obsidian/Plugins/…" is the same folder. */
  private isOwnPluginPath(path: string): boolean {
    const p = path.toLowerCase();
    const own = this.ownPluginDir.toLowerCase();
    return p === own || p.startsWith(`${own}/`);
  }

  private passesStructuralRules(path: string): boolean {
    if (path.endsWith(TEMP_SUFFIX)) return false;
    const segments = path.split("/");
    if (segments.includes(".git")) return false;
    if (this.isOwnPluginPath(path)) return false;
    const configDir = this.settings.configDir;
    if (path.startsWith(`${configDir}/`)) {
      if (!this.settings.syncConfigDir) return false;
      const rel = path.slice(configDir.length + 1);
      if (CORE_CONFIG_FILES.includes(rel)) return this.settings.syncCoreSettings;
      if (WORKSPACE_FILES.includes(rel)) return this.settings.syncWorkspace;
      if (rel === "community-plugins.json" || rel.startsWith("plugins/")) return this.settings.syncPlugins;
      if (rel.startsWith("themes/") || rel.startsWith("snippets/")) return this.settings.syncThemesAndSnippets;
      return false;
    }
    if (path === IGNORE_FILE) return true;
    // Other hidden files/folders are not part of the Obsidian vault and are not synchronised.
    return !segments.some((s) => s.startsWith("."));
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const NON_PORTABLE_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/**
 * A path every supported platform can represent unambiguously. Windows silently strips trailing dots and
 * spaces, treats ":" as a stream separator and reserves device names – such names from another device could
 * address a different file. They are never synchronised (and therefore never treated as deleted either).
 */
export function isPortablePath(path: string): boolean {
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment.length > 255) return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    if (NON_PORTABLE_CHARS.test(segment)) return false;
    if (WINDOWS_RESERVED.test(segment)) return false;
  }
  return true;
}
