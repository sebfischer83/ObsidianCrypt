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
 *
 * The matcher never uses regular expressions: the file is synchronised to every device, so a pathological
 * rule must not be able to freeze them (catastrophic regex backtracking). Segments are matched with a
 * linear wildcard matcher and "**" with a small dynamic programme over path segments.
 */

type Token =
  | { readonly t: "lit"; readonly c: string }
  | { readonly t: "one" }
  | { readonly t: "star" }
  | { readonly t: "class"; readonly negated: boolean; readonly items: ReadonlyArray<readonly [string, string]> };

type Segment = { readonly globstar: true } | { readonly globstar: false; readonly tokens: readonly Token[] };

interface Rule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly segments: readonly Segment[];
  /** A trailing "**" must match at least one segment ("dir/**" = everything inside dir). */
  readonly trailingGlobstar: boolean;
}

/** Bounds per rule (far above anything useful; keeps the matching cost predictable). */
const MAX_RULE_LENGTH = 1024;
const MAX_SEGMENTS = 64;

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
      if (ruleMatches(rule, parts)) ignored = !rule.negated;
    }
    return ignored;
  }

  /** True if a folder is ignored (so scanning need not descend). */
  isFolderIgnored(folderPath: string): boolean {
    const parts = folderPath.split("/");
    let ignored = false;
    for (const rule of this.rules) {
      let matched = false;
      for (let i = 1; i <= parts.length && !matched; i++) matched = matchPath(rule, parts.slice(0, i));
      if (matched) ignored = !rule.negated;
    }
    // A negated rule might re-include something below; only skip if no negation exists at all.
    return ignored && !this.rules.some((r) => r.negated);
  }
}

function ruleMatches(rule: Rule, parts: readonly string[]): boolean {
  // Ancestor folders (dir rules and plain rules both match folders).
  for (let i = 1; i < parts.length; i++) {
    if (matchPath(rule, parts.slice(0, i))) return true;
  }
  if (rule.directoryOnly) return false;
  return matchPath(rule, parts);
}

function parseRule(raw: string): Rule | null {
  let line = raw.replace(/\s+$/, "");
  if (line === "" || line.startsWith("#") || line.length > MAX_RULE_LENGTH) return null;
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
  const segments: Segment[] = [];
  if (!anchored) segments.push({ globstar: true });
  for (const part of line.split("/")) {
    if (part === "") continue;
    const segment: Segment = part === "**" ? { globstar: true } : { globstar: false, tokens: parseGlob(part) };
    // Consecutive "**" are equivalent to one.
    if (segment.globstar && segments[segments.length - 1]?.globstar) continue;
    segments.push(segment);
  }
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  const trailingGlobstar = anchored && (segments[segments.length - 1] as Segment).globstar && segments.length > 1;
  return { negated, directoryOnly, segments, trailingGlobstar };
}

/** Tokens of one path segment. "**" inside a segment behaves like "*" (it never crosses folders). */
function parseGlob(glob: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      while (glob[i] === "*") i++;
      tokens.push({ t: "star" });
    } else if (c === "?") {
      tokens.push({ t: "one" });
      i++;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) {
        tokens.push({ t: "lit", c: "[" });
        i++;
        continue;
      }
      let body = glob.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      const items: Array<[string, string]> = [];
      const chars = [...body];
      for (let k = 0; k < chars.length; k++) {
        let from = chars[k] as string;
        if (from === "\\" && k + 1 < chars.length) from = chars[++k] as string;
        if (chars[k + 1] === "-" && k + 2 < chars.length) {
          const to = chars[k + 2] as string;
          k += 2;
          // A reversed range matches nothing (like fnmatch); it is simply left out.
          if (from <= to) items.push([from, to]);
        } else {
          items.push([from, from]);
        }
      }
      tokens.push({ t: "class", negated, items });
      i = end + 1;
    } else if (c === "\\" && i + 1 < glob.length) {
      tokens.push({ t: "lit", c: glob[i + 1] as string });
      i += 2;
    } else {
      tokens.push({ t: "lit", c });
      i++;
    }
  }
  return tokens;
}

function tokenMatches(token: Token, ch: string): boolean {
  switch (token.t) {
    case "lit":
      return token.c === ch;
    case "one":
      return true;
    case "class":
      return token.items.some(([from, to]) => ch >= from && ch <= to) !== token.negated;
    case "star":
      return false;
  }
}

/** Wildcard match of one segment; O(tokens × characters) worst case, no backtracking explosion. */
function matchSegment(tokens: readonly Token[], text: string): boolean {
  const chars = [...text];
  let ti = 0;
  let ci = 0;
  let starToken = -1;
  let starChar = 0;
  while (ci < chars.length) {
    const token = tokens[ti];
    if (token && token.t === "star") {
      starToken = ti++;
      starChar = ci;
    } else if (token && tokenMatches(token, chars[ci] as string)) {
      ti++;
      ci++;
    } else if (starToken >= 0) {
      // Let the last star absorb one more character and retry from there.
      ti = starToken + 1;
      ci = ++starChar;
    } else {
      return false;
    }
  }
  while (tokens[ti]?.t === "star") ti++;
  return ti === tokens.length;
}

/** Segment-level match with "**" = any number of segments; O(segments × path parts). */
function matchPath(rule: Rule, parts: readonly string[]): boolean {
  const segs = rule.segments;
  const n = segs.length;
  const m = parts.length;
  // reach[j] = the first i segments can match the first j parts.
  let reach = new Array<boolean>(m + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < n; i++) {
    const seg = segs[i] as Segment;
    const next = new Array<boolean>(m + 1).fill(false);
    if (seg.globstar) {
      const atLeastOne = rule.trailingGlobstar && i === n - 1;
      let any = false;
      for (let j = 0; j <= m; j++) {
        if (atLeastOne) next[j] = any;
        if (reach[j]) any = true;
        if (!atLeastOne) next[j] = any;
      }
    } else {
      for (let j = 1; j <= m; j++) next[j] = reach[j - 1] === true && matchSegment(seg.tokens, parts[j - 1] as string);
    }
    reach = next;
  }
  return reach[m] === true;
}
