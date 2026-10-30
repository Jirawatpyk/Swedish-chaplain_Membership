/**
 * D-039 (the maintainer, 29 Oct 2026; AURA #185, 5.69) — every bottom bar is
 * an edge strip below 640px and a floating card from 640px.
 *
 * (a) Every AURA `<ActionBar` in `src/` that sticks to the screen (anything but
 *     `position="container"`) carries `edgeBelow="sm"`.
 *     An aliased import (`ActionBar as Bar`) is followed to `<Bar`.
 * (b) Nothing outside the legacy kit builds a bottom bar by hand:
 *     - in `.tsx`, a class list with `fixed` and `bottom-*` / `inset-x-0`, or
 *       `sticky` and `bottom-0`, read per line AND per JSX opening tag (so a
 *       `cn('fixed',\n 'bottom-0')` split over lines is seen), or an inline
 *       `style` with `position: 'fixed' | 'sticky'` and a `bottom` / `inset`;
 *     - in `.css` under `src/`, a rule with `position: fixed | sticky` and
 *       `bottom` / `inset`.
 *     One stays only with a reason within the 12 lines above it (and below the
 *     previous one): `stand-in until AURA #NN`, or `AURA app content:` (not a
 *     bar, e.g. a toast). A dialog's buttons go in AURA Dialog's `footer`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function sourceFiles(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

/**
 * Comments blanked to spaces, so line numbers and offsets survive. String
 * aware: `//` in "https://…" and `/*` in accept="image/*" are not comments.
 */
export function blankComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 2;
      const stop = end <= 1 ? source.length : next === '/' ? end : end;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const AURA_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@jirawatpyk\/aura-react['"]/g;

/** The local names AURA's `ActionBar` is imported under in this file (`ActionBar`, or an `as` alias). */
export function actionBarNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(AURA_IMPORT)) {
    for (const spec of m[1]!.split(',')) {
      const named = /^\s*ActionBar(?:\s+as\s+(\w+))?\s*$/.exec(spec);
      if (named) names.push(named[1] ?? 'ActionBar');
    }
  }
  return names;
}

/** Every opening JSX tag (`<Name …>`, props may span lines; `>` inside `{…}` is skipped), with its start offset. */
export function openingTags(source: string, name = String.raw`[A-Za-z][\w.]*`): Array<{ start: number; text: string }> {
  const tags: Array<{ start: number; text: string }> = [];
  const re = new RegExp(String.raw`<(?:${name})(?![\w.])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push({ start: m.index, text: source.slice(m.index, i + 1) });
  }
  return tags;
}

/** A class token, with any `max-md:` / `[@media…]:` style prefixes. */
const token = (name: string) => new RegExp(String.raw`(?:^|[\s"'\x60{])(?:[\w\-\[\]@():.]+:)*${name}`);
const FIXED = token(String.raw`fixed(?![\w-])`);
const STICKY = token(String.raw`sticky(?![\w-])`);
const BOTTOM_ANY = token(String.raw`(?:bottom-[\w\[]|inset-x-0)`);
const BOTTOM_0 = token(String.raw`bottom-0(?![\w-])`);

const INLINE_POSITION = /\bposition\s*:\s*['"](?:fixed|sticky)['"]/;
const INLINE_BOTTOM = /\b(?:bottom|inset|insetBlockEnd)\s*:/;

/** Tailwind classes or an inline `style` that pin something to the bottom of the screen. */
export function isHandBuiltBottomBar(text: string): boolean {
  return (
    (FIXED.test(text) && BOTTOM_ANY.test(text)) ||
    (STICKY.test(text) && BOTTOM_0.test(text)) ||
    (INLINE_POSITION.test(text) && INLINE_BOTTOM.test(text))
  );
}

const CSS_POSITION = /\bposition\s*:\s*(?:fixed|sticky)\b/;
const CSS_BOTTOM = /(?:^|[;{\s])(?:bottom|inset|inset-block-end|inset-block)\s*:/;

/** The offsets of `.css` rules (innermost `{…}` blocks) that pin something to the bottom. */
export function cssBottomBarRules(css: string): number[] {
  const out: number[] = [];
  for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
    if (CSS_POSITION.test(m[1]!) && CSS_BOTTOM.test(m[1]!)) out.push(m.index!);
  }
  return out;
}

const lineOf = (source: string, offset: number) => source.slice(0, offset).split('\n').length - 1;

const REASON = /stand-in until AURA #\d+|AURA app content:/;
const LEGACY_KIT = join('src', 'components', 'ui') + '/';
const outsideKit = (p: string) => !relative(ROOT, p).startsWith(LEGACY_KIT);
const files = sourceFiles(join(ROOT, 'src'), /\.tsx$/).filter(outsideKit);
const cssFiles = sourceFiles(join(ROOT, 'src'), /\.css$/).filter(outsideKit);

const bars = files.flatMap((path) => {
  const source = readFileSync(path, 'utf8').replace(/\r/g, '');
  const names = actionBarNames(source);
  if (names.length === 0) return [];
  return openingTags(blankComments(source), names.join('|')).map((tag) => ({ file: relative(ROOT, path), tag: tag.text }));
});

/** Each bar needs its own reason: the window above it stops at the previous bar, so one label never covers two. */
function reasoned(path: string, raw: string[], lines: number[]) {
  let previous = -1;
  return [...new Set(lines)].sort((a, b) => a - b).map((i) => {
    const from = Math.max(0, i - 12, previous + 1);
    previous = i;
    return { at: `${relative(ROOT, path)}:${i + 1}`, reasoned: raw.slice(from, i + 1).some((l) => REASON.test(l)) };
  });
}

const handBuilt = [
  ...files.flatMap((path) => {
    const text = readFileSync(path, 'utf8').replace(/\r/g, '');
    const code = blankComments(text);
    const perLine = code.split('\n').flatMap((line, i) => (isHandBuiltBottomBar(line) ? [i] : []));
    const perTag = openingTags(code).flatMap((tag) => (isHandBuiltBottomBar(tag.text) ? [lineOf(code, tag.start)] : []));
    // A tag already caught on one of its lines is counted at that line only.
    const tagOnly = perTag.filter((start) => !perLine.some((l) => l >= start && l <= start + 40));
    return reasoned(path, text.split('\n'), [...perLine, ...tagOnly]);
  }),
  ...cssFiles.flatMap((path) => {
    const text = readFileSync(path, 'utf8').replace(/\r/g, '');
    const code = blankComments(text);
    return reasoned(path, text.split('\n'), cssBottomBarRules(code).map((offset) => lineOf(code, offset)));
  }),
];

describe('D-039: bottom bars are an edge strip below 640px', () => {
  it('finds the viewport ActionBars (positive control)', () => {
    expect(bars.length).toBeGreaterThanOrEqual(14);
  });

  it.each(bars.filter((b) => !/\bposition="container"/.test(b.tag)).map((b) => [b.file, b.tag] as const))(
    '%s passes edgeBelow="sm"',
    (_file, tag) => {
      expect(tag).toMatch(/\bedgeBelow="sm"/);
    },
  );

  it('recognises a hand-built bottom bar (positive control)', () => {
    expect(isHandBuiltBottomBar('className="max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--x)]"')).toBe(true);
    expect(isHandBuiltBottomBar('className="sticky bottom-0 flex"')).toBe(true);
    expect(isHandBuiltBottomBar('className="fixed top-0 right-0"')).toBe(false);
    expect(isHandBuiltBottomBar('className="sticky top-0 bottom-4"')).toBe(false);
  });

  it('follows an aliased import and reads a tag split over lines (positive control)', () => {
    expect(actionBarNames("import { Button, ActionBar as Bar } from '@jirawatpyk/aura-react';")).toEqual(['Bar']);
    expect(openingTags('<Bar\n  label="x"\n  edgeBelow="sm"\n/>', 'Bar')[0]?.text).toContain('edgeBelow="sm"');
    const split = openingTags('<div className={cn(\n  "fixed",\n  "inset-x-0 bottom-0",\n)}>')[0]!.text;
    expect(isHandBuiltBottomBar(split)).toBe(true);
    expect(isHandBuiltBottomBar("<div style={{ position: 'fixed', bottom: 0 }}>")).toBe(true);
    expect(isHandBuiltBottomBar("<div style={{ position: 'fixed', top: 0 }}>")).toBe(false);
  });

  it('finds a bottom bar in a stylesheet (positive control)', () => {
    expect(cssBottomBarRules('.a { color: red }\n.bar { position: fixed; inset-inline: 0; bottom: 0; }')).toHaveLength(1);
    expect(cssBottomBarRules('.top { position: sticky; top: 0; }')).toHaveLength(0);
    expect(cssFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('reads code past a URL or a glob in a string (positive control)', () => {
    const code = blankComments('const a = "https://x"; const b = <i className="fixed inset-x-0 bottom-0" accept="image/*" />;');
    expect(isHandBuiltBottomBar(code)).toBe(true);
    expect(blankComments('a // b\nc /* d */ e')).toBe('a     \nc         e');
  });

  it('finds the reasoned hand-built bars that stay (positive control)', () => {
    // The bulk progress toast; the money dialogs' buttons are in AURA Dialog's
    // footer (PR N2) and the portal pay bar is AURA PageHeader's `actionsBar`
    // strip since 5.71 (#191).
    expect(handBuilt.filter((h) => h.reasoned).length).toBeGreaterThanOrEqual(1);
  });

  it('no hand-built bottom bar without a reason', () => {
    expect(handBuilt.filter((h) => !h.reasoned).map((h) => h.at)).toEqual([]);
  });
});
