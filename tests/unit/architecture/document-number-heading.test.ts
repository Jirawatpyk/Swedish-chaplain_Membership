/**
 * Every page title that carries a document number goes through
 * `<DocumentNumberHeading>`, and no file draws its own no-wrap number.
 *
 * #547 fixed the credit note's title (a no-wrap number widened the page at a
 * 32px default font); #561 then gave the invoice title its own no-wrap number
 * and the same bug came back (R50). One component, and this guard, keep the
 * two from drifting apart again.
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

// Skeletons draw a placeholder title, not a number.
const files = sourceFiles(join(ROOT, 'src')).filter((f) => !f.includes('/test-fixtures/') && !f.endsWith('/loading.tsx'));
const read = (f: string) => readFileSync(f, 'utf8').replace(/\r/g, '');

/** A PageHeader whose title mentions a document number. */
const NUMBER_TITLE = /<PageHeader[\s\S]{0,400}?title=\{[^}]*\b\w*[Nn]umber\b/;
/** A no-wrap span wrapped round a number. */
const NOWRAP_NUMBER = /whitespace-nowrap[^>]*>\s*\{\s*[\w.]*[Nn]umber\s*\}/;

describe('document-number page titles', () => {
  const titled = files.filter((f) => NUMBER_TITLE.test(read(f)));

  it('finds the document pages (a guard that finds nothing checks nothing)', () => {
    const names = titled.map((f) => relative(ROOT, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'src/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view.tsx',
        'src/app/(staff)/admin/credit-notes/_components/credit-note-detail-view.tsx',
      ]),
    );
  });

  it.each(titled.map((f) => [relative(ROOT, f), f]))('%s renders its title through DocumentNumberHeading', (_n, f) => {
    expect(read(f)).toMatch(/from ['"]@\/components\/layout\/document-number-heading['"]/);
  });

  it('no document page wraps a number in a no-wrap span of its own', () => {
    const offenders = titled.filter((f) => NOWRAP_NUMBER.test(read(f))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
