import { decodeText, diffLines, splitLines, type DiffLine } from "../util/diff";

/** Unchanged lines shown around each change; longer unchanged runs are collapsed. */
const CONTEXT = 3;

/**
 * Renders a line diff of two versions into `container`. `oldLabel`/`newLabel` name the "−" and "+" sides.
 * Binary or very different contents fall back to a short explanation.
 */
export function renderDiff(container: HTMLElement, oldBytes: Uint8Array, newBytes: Uint8Array, oldLabel: string, newLabel: string): void {
  container.empty();
  const oldText = decodeText(oldBytes);
  const newText = decodeText(newBytes);
  if (oldText === null || newText === null) {
    container.createEl("p", { text: `Binary content – no line comparison (${oldLabel}: ${oldBytes.length} bytes, ${newLabel}: ${newBytes.length} bytes).` });
    return;
  }
  const diff = diffLines(splitLines(oldText), splitLines(newText));
  if (diff === null) {
    container.createEl("p", { text: "The versions differ too much for a line comparison." });
    return;
  }
  const added = diff.filter((l) => l.type === "added").length;
  const removed = diff.filter((l) => l.type === "removed").length;
  const legend = container.createDiv({ cls: "encrypted-sync-diff-legend" });
  legend.createSpan({ cls: "encrypted-sync-diff-removed", text: `− ${oldLabel} (${removed})` });
  legend.createSpan({ cls: "encrypted-sync-diff-added", text: `+ ${newLabel} (${added})` });
  if (added === 0 && removed === 0) {
    container.createEl("p", { text: "Identical content." });
    return;
  }
  const pre = container.createEl("pre", { cls: "encrypted-sync-diff" });
  for (const block of collapse(diff)) {
    if (block === null) {
      pre.createDiv({ cls: "encrypted-sync-diff-skip", text: "⋯" });
      continue;
    }
    const prefix = block.type === "added" ? "+ " : block.type === "removed" ? "− " : "  ";
    pre.createDiv({ cls: `encrypted-sync-diff-${block.type}`, text: prefix + block.text });
  }
}

/** Keeps changed lines and CONTEXT lines around them; null marks a collapsed run. */
function collapse(diff: readonly DiffLine[]): Array<DiffLine | null> {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, i) => {
    if (line.type === "equal") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(diff.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: Array<DiffLine | null> = [];
  diff.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
