/**
 * F119 T155 finding U5 — no `italic` utility on this feature's own chrome.
 *
 * Thai has no italic form: the browser synthesises a slant, which hurts
 * legibility of Thai script. FR-044 already drops the italic CONTROL from the
 * toolbar under `th`; `halt-state-banner.tsx` then slanted a Thai string two
 * files away (`className="text-xs italic …"` over `t('readOnlyNote')`). Every
 * string on these surfaces renders in all three locales, so ANY `italic`
 * class here is a Thai italic.
 *
 * The scan reads SOURCE, not a frozen fixture, and it distinguishes the
 * Tailwind utility from Tiptap's `italic` MARK — the mark stays registered so
 * `<em>` from a paste or a template survives (`broadcast-editor-extensions`),
 * and `editor.isActive('italic')` must not be reported. A violation is the
 * token `italic` inside a CLASS string: a multi-token class list, or a
 * single-token one immediately behind `className=`.
 *
 * Positive control below: a detector that cannot tell "nothing to find" from
 * "not looking" is not a check (the `check:f8-error-id` lesson, CLAUDE.md
 * § Gotchas).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The component tree plus the route trees F119's screens live in. */
const SCANNED_ROOTS = [
  'src/components/broadcast',
  'src/app/(staff)/admin/broadcasts',
  'src/app/(member)/portal/broadcasts',
  'src/app/(staff)/admin/settings/broadcasts',
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments explain the rule; they are not the rule. Strip before matching.
 *
 * Round L1 — LINE comments go FIRST. The old order stripped block comments
 * first, so a line comment that merely MENTIONS a block-comment opener left a
 * stray opener behind and swallowed everything up to the next closer — real
 * code included. The `[^:]` guard keeps a `https://` inside a string from
 * being read as a comment.
 */
function stripComments(src: string): string {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Spans of a `cn(` / `clsx(` call, so a literal inside one can be located. */
function classHelperRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = /\b(?:cn|clsx|cva|twMerge)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

/** Every class-ish string literal this scan examined — the positive-control floor. */
export function countClassStringsScanned(src: string): number {
  let n = 0;
  const literal = /(className\s*=\s*)?(['"`])([^'"`\n]*)\2/g;
  const body = stripComments(src);
  while (literal.exec(body) !== null) n += 1;
  return n;
}

/**
 * The `italic` / `not-italic` Tailwind utility inside a class string.
 *
 * Matches `className="text-xs italic text-muted"`, `className="italic"` and —
 * round L1 — a lone `cn('italic')` / `clsx(cond && 'italic')`, which is how
 * this codebase composes conditional classes and which the old single-token
 * rule waved through. Still does NOT match `'italic'` as a Tiptap mark name,
 * `italicOn`, or `t('italic')`.
 */
export function findItalicClassUses(src: string): string[] {
  const hits: string[] = [];
  const stripped = stripComments(src);
  const ranges = classHelperRanges(stripped);
  const literal = /(className\s*=\s*)?(['"`])([^'"`\n]*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = literal.exec(stripped)) !== null) {
    const index = m.index;
    const isClassNameAttr = m[1] !== undefined;
    const body = m[3] ?? '';
    const tokens = body.split(/\s+/).filter((t) => t.length > 0);
    if (!tokens.includes('italic') && !tokens.includes('not-italic')) continue;
    const inClassHelper = ranges.some(([start, end]) => index >= start && index < end);
    if (tokens.length > 1 || isClassNameAttr || inClassHelper) hits.push(body);
  }
  return hits;
}

describe('U5 — no italic on the E-Blast surfaces (Thai has no italic form)', () => {
  const files = SCANNED_ROOTS.flatMap((root) => walk(resolve(process.cwd(), root)));

  it('the scan actually read the surfaces (a parse that finds nothing must not read as a pass)', () => {
    expect(files.length).toBeGreaterThan(20);
    // Round L2 — a file count only proves the WALK worked. If `stripComments`
    // or the literal regex ever returns nothing (the CRLF class, CLAUDE.md
    // § Gotchas), the walk still finds 30 files and the rule checks nothing.
    // The floor belongs on what the PARSE produced.
    const scanned = files.reduce(
      (n, f) => n + countClassStringsScanned(readFileSync(f, 'utf8')),
      0,
    );
    expect(scanned).toBeGreaterThan(200);
  });

  it('the detector fires on the exact shape that shipped (positive control)', () => {
    const shipped =
      'const x = <span className="text-xs italic text-muted-foreground">{t(\'readOnlyNote\')}</span>;';
    expect(findItalicClassUses(shipped)).toEqual(['text-xs italic text-muted-foreground']);
    // …and does NOT fire on the Tiptap mark, which must stay.
    expect(
      findItalicClassUses("editor.isActive('italic'); const k = 'italic';"),
    ).toEqual([]);
    // …nor on a comment that merely discusses it.
    expect(findItalicClassUses('// className="italic" was removed here\n')).toEqual([]);
    // Round L1 — the conditional-class form this codebase actually uses. A
    // lone `'italic'` used to be waved through as "probably the Tiptap mark".
    expect(findItalicClassUses("const c = cn('text-sm', isNote && 'italic');")).toEqual([
      'italic',
    ]);
    expect(findItalicClassUses('const c = clsx("italic");')).toEqual(['italic']);
    // Round L1 — a line comment naming a block-comment opener no longer eats
    // the code that follows it.
    expect(
      findItalicClassUses(
        '// the /* block comment */ form was removed\nconst c = <p className="italic" />;\n',
      ),
    ).toEqual(['italic']);
  });

  it('no file uses the italic utility', () => {
    const offenders = files
      .map((f) => ({ file: f, hits: findItalicClassUses(readFileSync(f, 'utf8')) }))
      .filter((r) => r.hits.length > 0);

    expect(
      offenders.map((o) => `${o.file}: ${o.hits.join(' | ')}`),
      'Thai renders every one of these strings — use weight or colour, never a synthetic slant.',
    ).toEqual([]);
  });
});
