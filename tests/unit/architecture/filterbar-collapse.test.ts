/**
 * Spec 122 (2026-10-15, AURA #146) — every list filter bar folds its filters
 * into AURA's "Filters (n)" sheet on phones.
 *
 * Each AURA `<FilterBar` in `src/` carries `collapseBelow="sm"`: below 640px
 * the bar keeps the search, chips, Clear all, count and actions, and the
 * filter controls move behind one button. The legacy kit's FilterBar
 * (`@/components/ui/filter-bar`, the US12 audience page) is not AURA's and is
 * left out.
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

const AURA_FILTERBAR_IMPORT =
  /import\s*\{[^}]*\bFilterBar\b[^}]*\}\s*from\s*['"]@jirawatpyk\/aura-react['"]/;

/** Every opening `<FilterBar …>` tag (props may span lines; `>` inside `{…}` is skipped). */
function filterBarTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<FilterBar\b/g;
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

const bars = sourceFiles(join(ROOT, 'src')).flatMap((path) => {
  const source = readFileSync(path, 'utf8').replace(/\r/g, '');
  if (!AURA_FILTERBAR_IMPORT.test(source)) return [];
  return filterBarTags(source).map((tag) => ({ file: relative(ROOT, path), tag }));
});

describe('AURA FilterBar folds its filters on phones', () => {
  it('finds the list filter bars (positive control)', () => {
    expect(bars.length).toBeGreaterThanOrEqual(12);
  });

  it.each(bars.map((b) => [b.file, b.tag] as const))('%s passes collapseBelow="sm"', (_file, tag) => {
    expect(tag).toMatch(/\bcollapseBelow="sm"/);
  });
});
