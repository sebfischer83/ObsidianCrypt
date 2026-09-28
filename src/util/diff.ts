/** Line-based diff (Myers' O(ND) algorithm) for comparing note versions. */

export interface DiffLine {
  readonly type: "equal" | "removed" | "added";
  readonly text: string;
}

/** Splits text into lines (without line terminators; "\r\n" and "\n" are equivalent). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Shortest edit script from `a` to `b`. Returns null if the texts differ in more than `maxEdits` lines
 * (bounds time and memory for unrelated files).
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = 4000): DiffLine[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const head: DiffLine[] = a.slice(0, prefix).map((text) => ({ type: "equal", text }));
  const tail: DiffLine[] = a.slice(a.length - suffix).map((text) => ({ type: "equal", text }));
  const middle = myers(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), maxEdits);
  return middle ? [...head, ...middle, ...tail] : null;
}

function myers(a: readonly string[], b: readonly string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = v[-d+1 .. d-1] at the start of round d (all that backtracking round d reads).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(d === 0 ? new Int32Array(0) : v.slice(offset - d + 1, offset + d));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)) ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[], dEnd: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const saved = trace[d] as Int32Array;
    const at = (k: number): number => saved[k + d - 1] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ type: "equal", text: a[--x] as string }), y--;
    if (x === prevX) out.push({ type: "added", text: b[--y] as string });
    else out.push({ type: "removed", text: a[--x] as string });
  }
  while (x > 0 && y > 0) out.push({ type: "equal", text: a[--x] as string }), y--;
  return out.reverse();
}

/** True if the bytes are text worth diffing (valid UTF-8 without NUL bytes). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
