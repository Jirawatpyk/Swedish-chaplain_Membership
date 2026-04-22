/**
 * T-SAN — Unit tests for `sanitiseErrorReason` (F4 Phase 9 / PG-3).
 *
 * Constitution Principle II requires 100% branch coverage on security-
 * critical use cases. `voidInvoice` is security-critical (terminal
 * financial action + PII in the render path), so the sanitiser that
 * bounds what `pdf_render_failed.reason` can carry MUST be covered.
 *
 * Two branches:
 *   - truncation (input.length > 200 → slice + ellipsis)
 *   - Thai tax-ID redaction (any run of 13 consecutive digits →
 *     '[REDACTED-TAXID]')
 */
import { describe, expect, it } from 'vitest';
import { sanitiseErrorReason } from '@/modules/invoicing/application/use-cases/void-invoice';

describe('sanitiseErrorReason (PG-3)', () => {
  it('short string passes through unchanged', () => {
    expect(sanitiseErrorReason('render failed: unknown error')).toBe(
      'render failed: unknown error',
    );
  });

  it('string > 200 chars is truncated with ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = sanitiseErrorReason(long);
    // 200 chars of payload + 1 ellipsis character
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(200))).toBe(true);
  });

  it('13-digit sequence is redacted (single occurrence)', () => {
    const input = 'render error for tax_id=1234567890123 field';
    expect(sanitiseErrorReason(input)).toBe(
      'render error for tax_id=[REDACTED-TAXID] field',
    );
  });

  it('multiple 13-digit sequences all redacted', () => {
    const input = 'buyer 1234567890123 seller 9876543210987';
    expect(sanitiseErrorReason(input)).toBe(
      'buyer [REDACTED-TAXID] seller [REDACTED-TAXID]',
    );
  });

  it('runs longer than 13 digits — only the first 13 redacted (by-design greedy)', () => {
    // Known limitation per PG-3 agent note: `\d{13}` matches the first
    // 13 digits in a 14+ digit run; remaining tail digits are left as-
    // is. Documented here so future tightening (e.g., `\d{13,}`) has a
    // regression anchor.
    const input = 'id 12345678901234567 end';
    expect(sanitiseErrorReason(input)).toBe('id [REDACTED-TAXID]4567 end');
  });

  it('non-string input is coerced via String() then sanitised', () => {
    const errObj = { message: 'render failed 1234567890123' };
    // Default String(obj) yields "[object Object]" — confirms coercion
    // path does not throw; actual content does not include the digits
    // embedded in object fields (this is a known limit per PG-3 agent:
    // crafted toString()/toJSON() could still leak, but is out of scope
    // for the default error shape). Test documents current behavior.
    const out = sanitiseErrorReason(errObj);
    expect(out).toBe('[object Object]');
  });

  it('truncation preserves any redactions that landed in the first 200 chars', () => {
    const before = 'x'.repeat(50);
    const tax = '1234567890123';
    const after = 'y'.repeat(400);
    const input = `${before}${tax}${after}`;
    const out = sanitiseErrorReason(input);
    expect(out).toContain('[REDACTED-TAXID]');
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
  });
});
