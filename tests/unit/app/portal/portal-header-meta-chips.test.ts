/**
 * Spec 122 US12d-1 (the user, 24 Oct: "the chips touch") — AURA's PageHeader
 * `meta` is a text line, so chips placed in it sat 0px apart. Boards `Main`
 * and `Benefits` draw them as a wrapping row 8px apart. AURA 5.62 (#177) laid
 * out a `meta` of elements only as that row, but in `next dev` a server chip
 * reaches the client as a `react.lazy` node its guess missed (R84). AURA 5.63
 * (#178) adds `metaLayout`: every portal `meta` that holds a Badge or
 * StatusPill asks for the row with `metaLayout="row"` (set before `meta`),
 * and no longer wraps its chips in the old stand-in row div.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/app/(member)/portal', 'src/app/test-fixtures/aura-portal'];
const OLD_ROW = '<div className="flex flex-wrap items-center gap-2">';

const files = ROOTS.flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `${root}/${f.replace(/\\/g, '/')}`),
);

/** Each `meta={…}` prop body, cut at its matching brace, with the header props before it. */
function metaProps(src: string): Array<{ body: string; before: string }> {
  const found: Array<{ body: string; before: string }> = [];
  for (let i = src.indexOf('meta={'); i !== -1; i = src.indexOf('meta={', i + 1)) {
    let depth = 0;
    for (let j = i + 5; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) {
        found.push({ body: src.slice(i + 6, j), before: src.slice(src.lastIndexOf('<PageHeader', i), i) });
        break;
      }
    }
  }
  return found;
}

const chipMetas = files.flatMap((f) =>
  metaProps(readFileSync(f, 'utf8'))
    .filter((m) => /<(Badge|StatusPill)\b/.test(m.body))
    .map((m) => ({ file: f, ...m })),
);

describe('portal page-header meta chips', () => {
  it('finds the chip metas (positive control: Dashboard and Benefits)', () => {
    const owners = chipMetas.map((m) => m.file);
    expect(owners).toContain('src/app/(member)/portal/(home)/page.tsx');
    expect(owners).toContain('src/app/(member)/portal/benefits/page.tsx');
  });

  it('asks AURA for the chip row with metaLayout="row"', () => {
    expect(chipMetas.filter((m) => !m.before.includes('metaLayout="row"')).map((m) => m.file)).toEqual([]);
  });

  it('no longer wraps the chips in the stand-in row div', () => {
    expect(chipMetas.filter((m) => m.body.includes(OLD_ROW)).map((m) => m.file)).toEqual([]);
  });
});
