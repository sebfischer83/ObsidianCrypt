/**
 * `.vaultsyncignore` rules with gitignore-like syntax:
 *
 *   # comment          blank lines are ignored
 *   *.tmp              no slash → matches the name at any depth
 *   Temp/              trailing slash → folder (and everything below)
 *   /Inbox.md          leading slash or inner slash → anchored at the vault root
 *   docs/**\/draft.md  "**" matches any number of folders, "*" and "?" never match "/"
 *   !keep.tmp          negation re-includes a previously ignored path (last match wins)
 *
 * Difference to git: a negation can re-include a file inside an ignored folder.
 * Matching is case-sensitive so every device evaluates rules identically.
 */

interface Rule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

export class IgnoreMatcher {
  private readonly rules: Rule[];

  constructor(source: string | readonly string[]) {
    const lines = typeof source === "string" ? source.split(/\r?\n/) : source;
    this.rules = [];
    for (const raw of lines) {
      const rule = parseRule(raw);
      if (rule) this.rules.push(rule);
    }
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /** True if the file path (or one of its ancestor folders) is ignored. */
  isIgnored(path: string): boolean {
    const parts = path.split("/");
    let ignored = false;
    for (const rule of this.rules) {
      if (this.ruleMatches(rule, parts)) ignored = !rule.negated;
    }
    return ignored;
  }

  /** True if a folder is ignored (so scanning need not descend). */
  isFolderIgnored(folderPath: string): boolean {
    const parts = folderPath.split("/");
    let ignored = false;
    for (const rule of this.rules) {
      let matched = false;
      for (let i = 1; i <= parts.length; i++) {
        if (rule.regex.test(parts.slice(0, i).join("/"))) matched = true;
      }
      if (matched) ignored = !rule.negated;
    }
    // A negated rule might re-include something below; only skip if no negation exists at all.
    return ignored && !this.rules.some((r) => r.negated);
  }

  private ruleMatches(rule: Rule, parts: string[]): boolean {
    // Ancestor folders (dir rules and plain rules both match folders).
    for (let i = 1; i < parts.length; i++) {
      if (rule.regex.test(parts.slice(0, i).join("/"))) return true;
    }
    if (rule.directoryOnly) return false;
    return rule.regex.test(parts.join("/"));
  }
}

function parseRule(raw: string): Rule | null {
  let line = raw.replace(/\s+$/, "");
  if (line === "" || line.startsWith("#")) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.replace(/\/+$/, "");
  }
  if (line === "") return null;
  const anchored = line.startsWith("/") || line.includes("/");
  line = line.replace(/^\/+/, "");
  const body = globToRegex(line);
  const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  return { negated, directoryOnly, regex };
}

function globToRegex(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" → any folders (including none); "**" at end → anything
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) {
        out += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = end + 1;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1] as string);
      i += 2;
    } else {
      out += escapeRegex(c);
      i += 1;
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
