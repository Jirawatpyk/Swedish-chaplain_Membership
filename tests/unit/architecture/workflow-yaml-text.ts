/**
 * Read a GitHub Actions workflow as TEXT — no YAML dependency (Constitution X).
 *
 * Shared by the workflow guards in this folder (post-deploy-smoke, e2e CI).
 * Lines are split on `\r?\n` so a guard is not inert on a Windows CRLF
 * checkout. Every guard that uses these helpers keeps its own positive
 * control: a fixture it must flag, and a check that the real file's parse is
 * not empty.
 */

export interface RunBlock {
  /** 1-based line of the `run:` key. */
  readonly line: number;
  readonly text: string;
}

/** A `${{ }}` value an attacker can choose (event payload or dispatch input). */
export const INJECTABLE = /\$\{\{\s*(github\.event\.|inputs\.)/;

export function lines(src: string): string[] {
  return src.split(/\r?\n/);
}

/** Comment-only lines removed, so prose in a comment cannot satisfy or trip a rule. */
export function codeLines(src: string): string[] {
  return lines(src).filter((l) => !/^\s*#/.test(l));
}

export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Every `run:` value — a single line, or a `|` / `>` block scalar. */
export function runBlocks(src: string): RunBlock[] {
  const all = lines(src);
  const blocks: RunBlock[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(all[i]!);
    if (m === null) continue;
    const keyIndent = m[1]!.length + (all[i]!.trimStart().startsWith('-') ? 2 : 0);
    const rest = m[2]!;
    if (/^[|>][-+]?\s*$/.test(rest)) {
      const body: string[] = [];
      let j = i + 1;
      while (j < all.length && (all[j]!.trim() === '' || indentOf(all[j]!) > keyIndent)) {
        body.push(all[j]!);
        j += 1;
      }
      blocks.push({ line: i + 1, text: body.join('\n') });
      i = j - 1;
    } else {
      blocks.push({ line: i + 1, text: rest });
    }
  }
  return blocks;
}

export function stepCount(src: string): number {
  return codeLines(src).filter((l) => /^\s*-\s+(uses|name|run|id):/.test(l)).length;
}

/**
 * [start, end) 0-based line range of the first step whose `- name:` (or
 * `- uses:`) line matches, or `null` when none does.
 */
export function stepRange(src: string, name: RegExp): { start: number; end: number } | null {
  const all = lines(src);
  const start = all.findIndex((l) => name.test(l));
  if (start < 0) return null;
  const stepIndent = indentOf(all[start]!);
  let end = start + 1;
  while (end < all.length && !(indentOf(all[end]!) <= stepIndent && all[end]!.trim() !== '')) end += 1;
  return { start, end };
}
