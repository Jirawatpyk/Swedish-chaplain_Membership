/**
 * Spec 122 board-parity rule (docs/aura-adoption.md) — no unlabelled reach
 * into AURA's internal classes on a screen that is on AURA.
 *
 * AURA's element and modifier classes (`aura-card__body`, `aura-alert--info`,
 * `.aura-tbl-wrap`, the `aura-tbl` container) are not its API: a rename in a
 * minor release breaks the reach silently. Every reach in a migrated path is
 * therefore one of:
 *   - a stand-in, labelled `stand-in until AURA #NN` where #NN is an item the
 *     adoption doc lists as OPEN (a label naming a shipped item is stale: the
 *     reach should have been swapped for AURA's prop when the item shipped);
 *   - app content (AURA's owner agreed it is not AURA styling), labelled
 *     `AURA app content: <why>`.
 * A label covers the reaches on its own line and the LABEL_WINDOW lines below.
 *
 * Scope: every `MIGRATED_PATHS` entry of `eslint.config.mjs` (so each phase
 * that moves to AURA joins this check in the PR that adds its paths) plus
 * `src/app/globals.css`.
 *
 * Positive controls: a scan that finds nothing must fail, not pass — every
 * glob must match a file, the tree must contain reaches, the doc must yield
 * open items, and a known unlabelled reach must be flagged. Lines are split on
 * `\r?\n` so a Windows (autocrlf) checkout checks the same thing as CI
 * (CLAUDE.md Gotchas, #351).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATED_PATHS } from '../../../eslint.config.mjs';

const ROOT = join(__dirname, '../../..');
const EXTRA_FILES = ['src/app/globals.css'];
const LABEL_WINDOW = 12;

/** Reaches into AURA internals, matched per line with comments blanked out. */
const REACH_PATTERNS: readonly RegExp[] = [
  // BEM element / modifier: aura-card__body, aura-alert--info, .aura-tbl--stack-sm
  /\baura-[a-z0-9]+(?:-[a-z0-9]+)*(?:__|--)[a-z0-9]/,
  // a class selector: [&_.aura-tbl-wrap], in-[.aura-table--stacked], closest('.aura-x'), CSS rules
  /\.aura-[a-z]/,
  // AURA's named container: a Tailwind variant (`@max-[640px]/aura-tbl:`) or a CSS `@container aura-tbl`
  /@[a-z0-9-]*(?:\[[^\]]*\])?\/aura-[a-z-]+:|@container\s+aura-[a-z]/,
  // hand-written block classes in markup (className="aura-card", "aura-icon")
  /(?:^|["'`\s])aura-(?:card|alert|empty|stat|progress|crumbs|nav|tbl|table|tabs|drawer|shell|bottomnav|filterbar|check|choice|segmented|icon)(?=["'`\s]|$)/,
];

const LABEL = /stand-in until AURA #(\d+)|AURA app content:/i;

export interface Reach {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** The item a covering label names; null for app content; undefined when unlabelled. */
  readonly item: number | null | undefined;
}

/** `**`, `*` and `\[` `\]` escapes, as eslint's minimatch reads MIGRATED_PATHS; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '\\' && i + 1 < glob.length) {
      re += `\\${glob[i + 1]}`;
      i += 1;
    } else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else re += /[.+^${}()|[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

/** Comments replaced by spaces, newlines kept, so line numbers still match the source. */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\r\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

export function findReaches(file: string, source: string): Reach[] {
  const raw = source.split(/\r?\n/);
  const code = blankComments(source).split(/\r?\n/);
  const reaches: Reach[] = [];
  code.forEach((line, i) => {
    if (!REACH_PATTERNS.some((p) => p.test(line))) return;
    let item: number | null | undefined;
    for (let j = i; j >= Math.max(0, i - LABEL_WINDOW); j -= 1) {
      const m = LABEL.exec(raw[j] ?? '');
      if (m) {
        item = m[1] === undefined ? null : Number(m[1]);
        break;
      }
    }
    reaches.push({ file, line: i + 1, text: (raw[i] ?? '').trim().slice(0, 140), item });
  });
  return reaches;
}

/** The item numbers in the adoption doc's open-items table (`| Item | AURA gap | …`). */
export function openItems(doc: string): Set<number> {
  const lines = doc.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\|\s*Item\s*\|\s*AURA gap\s*\|/.test(l));
  const items = new Set<number>();
  if (head < 0) return items;
  for (const l of lines.slice(head + 2)) {
    const m = /^\|\s*#(\d+)\s*\|/.exec(l);
    if (!m) break;
    items.add(Number(m[1]));
  }
  return items;
}

/** Reaches that fail the rule: unlabelled, or labelled with an item that is not open. */
export function violations(reaches: readonly Reach[], open: ReadonlySet<number>): string[] {
  return reaches
    .filter((r) => r.item === undefined || (r.item !== null && !open.has(r.item)))
    .map((r) => `${r.file}:${r.line} ${r.item === undefined ? 'unlabelled' : `#${r.item} is not an open item`}: ${r.text}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, path).replace(/\\/g, '/'));
  }
  return out;
}

const globs = MIGRATED_PATHS.map((g: string) => ({ glob: g, re: globToRegExp(g) }));
const allSrc = walk(join(ROOT, 'src'));
const scanned = [...new Set([...allSrc.filter((f) => globs.some((g) => g.re.test(f))), ...EXTRA_FILES])].sort();
const open = openItems(readFileSync(join(ROOT, 'docs/aura-adoption.md'), 'utf8'));
const reaches = scanned.flatMap((f) => findReaches(f, readFileSync(join(ROOT, f), 'utf8')));

describe('AURA internal-class ratchet (spec 122 parity rule)', () => {
  it('every MIGRATED_PATHS glob matches at least one file (a dead glob checks nothing)', () => {
    expect(globs.length).toBeGreaterThan(50);
    expect(globs.filter((g) => !allSrc.some((f) => g.re.test(f))).map((g) => g.glob)).toEqual([]);
  });

  it('the scan finds files, reaches and open items (positive control)', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(reaches.length).toBeGreaterThan(0);
    expect(open.size).toBeGreaterThan(0);
    // the worked example: the change-request queue's #85 stand-in is scanned and labelled
    const queue = reaches.filter((r) => r.file.endsWith('admin/change-requests/_components/queue-table.tsx'));
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((r) => r.item === 85)).toBe(true);
  });

  it('every reach is labelled, and every label names an open item', () => {
    expect(violations(reaches, open)).toEqual([]);
  });

  describe('the checker itself', () => {
    const openSet = new Set([85]);
    const unlabelled = 'export const A = () => (\n  <div className="[&_.aura-tbl-wrap]:border-0" />\n);\n';
    const labelled = '// A stand-in until AURA #85 (separate cards).\nconst X = "max-sm:[&_.aura-tbl-wrap]:border-0";\n';
    const shipped = '// stand-in until AURA #81\nconst X = "[&_.aura-tbl-wrap]:border-0";\n';
    const appContent = '// AURA app content: the flag only on the desktop row.\nconst X = "in-[.aura-table--stacked]:hidden";\n';

    it('flags an unlabelled reach', () => {
      expect(violations(findReaches('f.tsx', unlabelled), openSet)).toHaveLength(1);
    });
    it('passes a reach labelled with an open item, and app content', () => {
      expect(violations(findReaches('f.tsx', labelled), openSet)).toEqual([]);
      expect(violations(findReaches('f.tsx', appContent), openSet)).toEqual([]);
    });
    it('flags a label that names a shipped item', () => {
      expect(violations(findReaches('f.tsx', shipped), openSet)).toEqual([expect.stringContaining('#81 is not an open item')]);
    });
    it('reads a CRLF file exactly like an LF one', () => {
      const crlf = (s: string) => s.replace(/\n/g, '\r\n');
      for (const src of [unlabelled, labelled, shipped, appContent]) {
        expect(findReaches('f.tsx', crlf(src))).toEqual(findReaches('f.tsx', src));
      }
      const doc = '| Item | AURA gap | Chamber-OS stand-in |\n|---|---|---|\n| #85 | a | b |\n| #86 | c | d |\n\nafter\n';
      expect([...openItems(crlf(doc))]).toEqual([85, 86]);
    });
    it('ignores reaches inside comments and AURA public classes', () => {
      expect(findReaches('f.css', '/* `.aura-skel` keeps its tone */\n.x { color: var(--aura-fg-primary); }\n')).toEqual([]);
      expect(findReaches('f.tsx', '<p className="aura-text-table-cell text-[var(--aura-fg-secondary)]" />\n')).toEqual([]);
    });
    it('catches each reach shape', () => {
      for (const line of [
        '<div className="aura-card__body" />',
        '<div className="aura-alert aura-alert--info" />',
        'const C = "@max-[640px]/aura-tbl:mb-3";',
        "target.closest('.aura-table__sel')",
        '.staff-nav .aura-nav__chevron { transform: none; }',
        '<span className="aura-icon" />',
      ]) {
        expect(findReaches('f.tsx', `${line}\n`), line).toHaveLength(1);
      }
    });
    it('reads escaped brackets in a glob as literal characters', () => {
      const re = globToRegExp('src/app/(member)/portal/invoices/\\[invoiceId\\]/*.tsx');
      expect(re.test('src/app/(member)/portal/invoices/[invoiceId]/page.tsx')).toBe(true);
      expect(re.test('src/app/(member)/portal/invoices/[invoiceId]/_components/x.tsx')).toBe(false);
    });
  });
});
