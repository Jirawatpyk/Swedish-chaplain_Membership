/**
 * Spec 122 US12d-1 (the user, 24 Oct: "the chips touch") — AURA's PageHeader
 * `meta` is a text line, so chips placed in it sat 0px apart. Boards `Main`
 * and `Benefits` draw them as a wrapping row 8px apart. Until AURA #177 gives
 * `meta` the `eyebrow` row, every portal `meta` that holds a Badge or
 * StatusPill wraps them in that row itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/app/(member)/portal', 'src/app/test-fixtures/aura-portal'];
// Leading `//` comments allowed (the pages say why the row is there).
const ROW = /^\s*(?:\/\/[^\n]*\n\s*)*<div className="flex flex-wrap items-center gap-2">/;

const files = ROOTS.flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `${root}/${f.replace(/\\/g, '/')}`),
);

/** Each `meta={…}` prop body, cut at its matching brace. */
function metaBodies(src: string): string[] {
  const bodies: string[] = [];
  for (let i = src.indexOf('meta={'); i !== -1; i = src.indexOf('meta={', i + 1)) {
    let depth = 0;
    for (let j = i + 5; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) {
        bodies.push(src.slice(i + 6, j));
        break;
      }
    }
  }
  return bodies;
}

const chipMetas = files.flatMap((f) =>
  metaBodies(readFileSync(f, 'utf8'))
    .filter((b) => /<(Badge|StatusPill)\b/.test(b))
    .map((b) => ({ file: f, body: b })),
);

describe('portal page-header meta chips', () => {
  it('finds the chip metas (positive control: Dashboard and Benefits)', () => {
    const owners = chipMetas.map((m) => m.file);
    expect(owners).toContain('src/app/(member)/portal/(home)/page.tsx');
    expect(owners).toContain('src/app/(member)/portal/benefits/page.tsx');
  });

  it('wraps the chips in a row 8px apart (stand-in until AURA #177)', () => {
    expect(chipMetas.filter((m) => !ROW.test(m.body)).map((m) => m.file)).toEqual([]);
  });
});
