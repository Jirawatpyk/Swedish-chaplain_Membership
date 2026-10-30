/**
 * D-039 (the maintainer, 29 Oct 2026; AURA #185, 5.69) — every bottom bar is
 * an edge strip below 640px and a floating card from 640px.
 *
 * (a) Every AURA `<ActionBar` in `src/` that sticks to the screen (anything but
 *     `position="container"`) carries `edgeBelow="sm"`.
 * (b) No `.tsx` outside the legacy kit builds a bottom bar by hand: a class
 *     list with `fixed` and `bottom-*` / `inset-x-0`, or `sticky` and
 *     `bottom-0`. A hand-built one stays only with a reason within the 12 lines
 *     above it: `stand-in until AURA #NN`, `AURA app content:` (not a bar, e.g.
 *     a toast), or `PR N2: Dialog footer` (the money-dialog footers, moved to
 *     AURA Dialog's `footer` in PR N2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx$/.test(name)) out.push(path);
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

const AURA_ACTIONBAR_IMPORT =
  /import\s*\{[^}]*\bActionBar\b[^}]*\}\s*from\s*['"]@jirawatpyk\/aura-react['"]/;

/** Every opening `<ActionBar …>` tag (props may span lines; `>` inside `{…}` is skipped). */
function actionBarTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<ActionBar\b/g;
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
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

/** A class token, with any `max-md:` / `[@media…]:` style prefixes. */
const token = (name: string) => new RegExp(String.raw`(?:^|[\s"'\x60{])(?:[\w\-\[\]@():.]+:)*${name}`);
const FIXED = token(String.raw`fixed(?![\w-])`);
const STICKY = token(String.raw`sticky(?![\w-])`);
const BOTTOM_ANY = token(String.raw`(?:bottom-[\w\[]|inset-x-0)`);
const BOTTOM_0 = token(String.raw`bottom-0(?![\w-])`);

export function isHandBuiltBottomBar(line: string): boolean {
  return (FIXED.test(line) && BOTTOM_ANY.test(line)) || (STICKY.test(line) && BOTTOM_0.test(line));
}

const REASON = /stand-in until AURA #\d+|AURA app content:|PR N2: Dialog footer/;
const LEGACY_KIT = join('src', 'components', 'ui') + '/';
const files = sourceFiles(join(ROOT, 'src')).filter((p) => !relative(ROOT, p).startsWith(LEGACY_KIT));

const bars = files.flatMap((path) => {
  const source = readFileSync(path, 'utf8').replace(/\r/g, '');
  if (!AURA_ACTIONBAR_IMPORT.test(source)) return [];
  return actionBarTags(blankComments(source)).map((tag) => ({ file: relative(ROOT, path), tag }));
});

const handBuilt = files.flatMap((path) => {
  const raw = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n');
  const code = blankComments(raw.join('\n')).split('\n');
  // Each bar needs its own reason: the window above it stops at the previous
  // hand-built bar, so one label never covers a second bar below it.
  let previous = -1;
  return code.flatMap((line, i) => {
    if (!isHandBuiltBottomBar(line)) return [];
    const from = Math.max(0, i - 12, previous + 1);
    previous = i;
    return [{ at: `${relative(ROOT, path)}:${i + 1}`, reasoned: raw.slice(from, i + 1).some((l) => REASON.test(l)) }];
  });
});

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

  it('reads code past a URL or a glob in a string (positive control)', () => {
    const code = blankComments('const a = "https://x"; const b = <i className="fixed inset-x-0 bottom-0" accept="image/*" />;');
    expect(isHandBuiltBottomBar(code)).toBe(true);
    expect(blankComments('a // b\nc /* d */ e')).toBe('a     \nc         e');
  });

  it('no hand-built bottom bar without a reason', () => {
    expect(handBuilt.filter((h) => !h.reasoned).map((h) => h.at)).toEqual([]);
  });
});
