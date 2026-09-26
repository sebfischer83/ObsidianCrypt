/**
 * Vault-relative path handling. All paths inside the plugin are NFC-normalised, use "/" separators and
 * never start or end with "/".
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const MAX_PATH_LENGTH = 1024;

export function normalizeVaultPath(path: string): string {
  return path.normalize("NFC").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Structural validity of a (normalised) vault path coming from untrusted data (e.g. the manifest). */
export function isValidVaultPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path !== path.normalize("NFC")) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("//")) return false;
  if (CONTROL_CHARS.test(path)) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/**
 * Key used for collision detection. Windows, macOS and iOS file systems are case-insensitive (and macOS
 * may decompose Unicode), so two paths that differ only by case or normalisation are the same file there.
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Splits "Note.md" into ["Note", ".md"]; dotfiles like ".vaultsyncignore" have no extension. */
export function splitExtension(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** All ancestor folders of a path, outermost first: "a/b/c.md" → ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
