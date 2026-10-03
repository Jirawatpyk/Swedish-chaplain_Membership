/**
 * Architecture test — one issue-time pricing source.
 *
 * `computeIssuePricing` (domain policy) is the single computation of a
 * draft's subtotal / VAT / total: the treatment-driven rate plus the
 * VAT-inclusive carve-out. `issueInvoice`, `issueEventInvoiceAsPaid`, the
 * draft PDF preview and the staff Issue dialog all price through it, so what
 * the admin previews is what the bill pins. Any other file importing or
 * calling the primitives (`calculateVat`, `splitVatInclusive`), or doing the
 * rate maths inline (`Money.multiplyByFraction`), is a second copy of the rule
 * that can drift — e.g. pricing a zero-rated or VAT-inclusive draft at 7% on
 * top. The primitives stay in the invoicing domain; everything else in `src/`
 * goes through the policy. (The barrel's re-exports stay for tests, which use
 * the primitives as an independent oracle.)
 *
 * Known gap, by design: a client component cannot import the invoicing
 * barrel, so the New invoice → Event fee form previews the VAT-inclusive
 * split with its own integer arithmetic (`previewVatInclusive` in
 * `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx`). This
 * scan cannot see plain arithmetic; that copy is held to the domain by a
 * fast-check parity test against `splitVatInclusive` (added by PR #515) in
 * `tests/unit/components/invoices/event-fee-form.test.tsx` instead.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SRC_DIR = join(PROJECT_ROOT, 'src');
// The primitives live here (and the policy that composes them); nothing else
// may re-derive issue pricing.
const PRICING_HOME = 'src/modules/invoicing/domain/';

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const PRIMITIVE_CALL = /\b(calculateVat|splitVatInclusive)\s*\(/;
// A named import of a primitive, aliased or not, single- or multi-line (`[^}]`
// spans newlines; no `\n` anchor, so a CRLF checkout parses the same).
const PRIMITIVE_IMPORT = /\bimport\s+(?:type\s+)?\{[^}]*\b(?:calculateVat|splitVatInclusive)\b[^}]*\}\s*from\b/;
// The rate maths itself, written inline on a Money.
const INLINE_RATE_MATHS = /\.multiplyByFraction\s*\(/;
// Comments are prose, not code: a rationale naming a primitive is not a bypass.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:'"`])\/\/[^\r\n]*/g;

/** The files the guard scans, project-relative. */
function scannedFiles(): string[] {
  return listTs(SRC_DIR)
    .map((f) => relative(PROJECT_ROOT, f).split('\\').join('/'))
    .filter((f) => !f.startsWith(PRICING_HOME));
}

/** Does this source re-derive issue pricing instead of calling the policy? */
function bypassesPricing(source: string): boolean {
  const code = source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1');
  return PRIMITIVE_CALL.test(code) || PRIMITIVE_IMPORT.test(code) || INLINE_RATE_MATHS.test(code);
}

describe('issue pricing goes through computeIssuePricing', () => {
  it('no file outside the invoicing domain imports or calls the VAT primitives', () => {
    const offenders = scannedFiles().filter((f) =>
      bypassesPricing(readFileSync(join(PROJECT_ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

// Positive control (CLAUDE.md § Gotchas): a source-scanning gate must prove it
// can SEE what it guards, or "nothing found" is indistinguishable from "not
// looking". Each form below is a way to re-derive issue pricing outside the
// policy; each must be flagged, and mere mentions must not be.
describe('bypassesPricing — positive control', () => {
  // The draft preview, the Issue dialog and the event-fee form live in
  // presentation; a second copy of the rule there drifts just the same.
  it('scans presentation (src/app) as well as the application layer', () => {
    const files = scannedFiles();
    expect(files.some((f) => f.startsWith('src/app/'))).toBe(true);
    expect(files.some((f) => f.startsWith('src/modules/invoicing/application/'))).toBe(true);
  });

  const flagged: Record<string, string> = {
    'a direct call': `const r = calculateVat(sub, rate);`,
    'an aliased import': `import { splitVatInclusive as split } from '@/modules/invoicing';\nconst r = split(t, 700n);`,
    'a multi-line aliased import': `import {\r\n  Money,\r\n  calculateVat as vatOf,\r\n} from '@/modules/invoicing';\r\nvatOf(a, b);`,
    'inline rate maths on Money': `const vat = subtotal.multiplyByFraction(rate.numerator, rate.denominator);`,
  };
  for (const [name, src] of Object.entries(flagged)) {
    it(`flags ${name}`, () => {
      expect(bypassesPricing(src)).toBe(true);
    });
  }

  const clean: Record<string, string> = {
    'the policy call': `const p = computeIssuePricing({ lineSum, vatInclusive, vatTreatment, standardRate });`,
    'a mention in a line comment': `// VAT is added on top → calculateVat(subtotal, rate).`,
    'a mention in a block comment': `/* back-calculate via splitVatInclusive(total, bps) */`,
  };
  for (const [name, src] of Object.entries(clean)) {
    it(`does not flag ${name}`, () => {
      expect(bypassesPricing(src)).toBe(false);
    });
  }
});
