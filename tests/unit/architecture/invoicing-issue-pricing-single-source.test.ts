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

describe('invoicing application layer — issue pricing goes through computeIssuePricing', () => {
  it('no application file calls calculateVat / splitVatInclusive directly', () => {
    const offenders = listTs(APP_DIR)
      .filter((f) => PRIMITIVE_CALL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(PROJECT_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
