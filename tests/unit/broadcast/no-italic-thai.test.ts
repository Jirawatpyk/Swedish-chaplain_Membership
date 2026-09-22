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

/** Comments explain the rule; they are not the rule. Strip before matching. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The `italic` / `not-italic` Tailwind utility inside a class string.
 *
 * Matches `className="text-xs italic text-muted"` and `className="italic"`;
 * does NOT match `'italic'` as a Tiptap mark name, `italicOn`, or
 * `t('italic')`.
 */
export function findItalicClassUses(src: string): string[] {
  const hits: string[] = [];
  const literal = /(className\s*=\s*)?(['"`])([^'"`\n]*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = literal.exec(stripComments(src))) !== null) {
    const isClassNameAttr = m[1] !== undefined;
    const body = m[3] ?? '';
    const tokens = body.split(/\s+/).filter((t) => t.length > 0);
    if (!tokens.includes('italic') && !tokens.includes('not-italic')) continue;
    if (tokens.length > 1 || isClassNameAttr) hits.push(body);
  }
  return hits;
}

describe('U5 — no italic on the E-Blast surfaces (Thai has no italic form)', () => {
  const files = SCANNED_ROOTS.flatMap((root) => walk(resolve(process.cwd(), root)));

  it('the scan actually read the surfaces (a parse that finds nothing must not read as a pass)', () => {
    expect(files.length).toBeGreaterThan(20);
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
