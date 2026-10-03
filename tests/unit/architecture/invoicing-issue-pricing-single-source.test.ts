/**
 * Architecture test — one issue-time pricing source.
 *
 * `computeIssuePricing` (domain policy) is the single computation of a
 * draft's subtotal / VAT / total: the treatment-driven rate plus the
 * VAT-inclusive carve-out. `issueInvoice`, `issueEventInvoiceAsPaid`, the
 * draft PDF preview and the staff Issue dialog all price through it, so what
 * the admin previews is what the bill pins. A use case calling the primitives
 * (`calculateVat`, `splitVatInclusive`) directly is a second copy of the rule
 * that can drift — e.g. pricing a zero-rated or VAT-inclusive draft at 7% on
 * top. The primitives stay in the domain; the application layer goes through
 * the policy.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const APP_DIR = join(PROJECT_ROOT, 'src', 'modules', 'invoicing', 'application');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const PRIMITIVE_CALL = /\b(calculateVat|splitVatInclusive)\s*\(/;

/** The files the guard scans, project-relative. */
function scannedFiles(): string[] {
  return listTs(APP_DIR).map((f) => relative(PROJECT_ROOT, f));
}

/** Does this source re-derive issue pricing instead of calling the policy? */
function bypassesPricing(source: string): boolean {
  return PRIMITIVE_CALL.test(source);
}

describe('invoicing application layer — issue pricing goes through computeIssuePricing', () => {
  it('no application file calls calculateVat / splitVatInclusive directly', () => {
    const offenders = listTs(APP_DIR)
      .filter((f) => bypassesPricing(readFileSync(f, 'utf8')))
      .map((f) => relative(PROJECT_ROOT, f));
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
