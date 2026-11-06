/**
 * A list Card with AURA `flushBelow` must also drop its padding and border at
 * the same breakpoint (docs/aura-adoption.md, list pages). AURA's flushBelow
 * removes the border colour, surface and shadow but keeps the padding and a
 * transparent 1px border (its docs: "Padding is kept"), so without both
 * classes the row cards sit 1–17px inside the page's other cards (PR Q: the
 * portal invoices list at 390, found by the maintainer).
 *
 * Every `<Card … flushBelow="sm|md|lg" …>` opening tag in `src/` carries
 * `max-<bp>:border-0` and `max-<bp>:p-0`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

function flushCards(): { file: string; bp: string; tag: string }[] {
  const found: { file: string; bp: string; tag: string }[] = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<Card\b[^>]*?flushBelow="(sm|md|lg)"[^>]*>/gs)) {
      found.push({ file: relative(ROOT, file), bp: m[1]!, tag: m[0] });
    }
  }
  return found;
}

describe('Card flushBelow drops padding and border too', () => {
  it('finds the list cards (positive control)', () => {
    expect(flushCards().length).toBeGreaterThanOrEqual(8);
  });

  it('every flushBelow Card carries max-<bp>:border-0 and max-<bp>:p-0', () => {
    const missing = flushCards()
      .filter(({ bp, tag }) => !tag.includes(`max-${bp}:border-0`) || !tag.includes(`max-${bp}:p-0`))
      .map(({ file, bp }) => `${file} (flushBelow="${bp}")`);
    expect(missing).toEqual([]);
  });
});
