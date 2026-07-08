/**
 * Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — CONTRACT
 * test for `createInvoiceDraftSchema`'s new `membershipCoverage` field.
 *
 * Asserts the schema:
 *   - accepts both discriminated-union kinds (`window` + `from_payment`);
 *   - accepts the field being entirely absent (optional — defaults inside
 *     the use-case to `{ kind: 'from_payment' }`);
 *   - rejects a malformed `window` (bad date shape on either `fromIso` or
 *     `toIso`, or an unrecognised `kind` literal).
 *
 * Use-case-level behaviour (the composed description text) is covered by
 * `tests/unit/invoicing/create-invoice-draft.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createInvoiceDraftSchema } from '@/modules/invoicing/application/use-cases/create-invoice-draft';

const baseInput = {
  tenantId: 'test-swecham',
  actorUserId: 'admin-user',
  memberId: '00000000-0000-0000-0000-00000000aaaa',
  planId: 'regular',
  planYear: 2026,
} as const;

describe('createInvoiceDraftSchema — membershipCoverage contract', () => {
  it('accepts input with membershipCoverage entirely absent (optional)', () => {
    const result = createInvoiceDraftSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.membershipCoverage).toBeUndefined();
    }
  });

  it('accepts { kind: "from_payment" }', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: { kind: 'from_payment' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.membershipCoverage).toEqual({ kind: 'from_payment' });
    }
  });

  it('accepts { kind: "window", fromIso, toIso } with YYYY-MM-DD dates', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '2027-06-01',
        toIso: '2028-06-01',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.membershipCoverage).toEqual({
        kind: 'window',
        fromIso: '2027-06-01',
        toIso: '2028-06-01',
      });
    }
  });

  it('accepts { kind: "window" } with full ISO timestamps (regex has no end anchor)', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '2027-06-01T00:00:00.000Z',
        toIso: '2028-06-01T00:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed "window" — fromIso not matching YYYY-MM-DD', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '06/01/2027', // wrong shape
        toIso: '2028-06-01',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed "window" — toIso not matching YYYY-MM-DD', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '2027-06-01',
        toIso: 'not-a-date',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a "window" input missing toIso', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: { kind: 'window', fromIso: '2027-06-01' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognised membershipCoverage.kind literal', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: { kind: 'calendar_year' },
    });
    expect(result.success).toBe(false);
  });

  // Task 8 review-fix (F2, defence-in-depth) — a reversed/equal window is a
  // tax-document-printing bug (the §86/4 would show "from 2028 to 2027").
  // No production caller can trigger this today (both bridges derive
  // `toIso` via `addMonthsUtc(fromIso, n>0)`), but a future caller must
  // fail loud at the schema boundary rather than silently print it.
  it('rejects a "window" where fromIso is NOT before toIso (reversed)', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '2028-06-01',
        toIso: '2027-06-01',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'membershipCoverage window: fromIso must be before toIso',
      );
    }
  });

  it('rejects a "window" where fromIso equals toIso', () => {
    const result = createInvoiceDraftSchema.safeParse({
      ...baseInput,
      membershipCoverage: {
        kind: 'window',
        fromIso: '2027-06-01',
        toIso: '2027-06-01',
      },
    });
    expect(result.success).toBe(false);
  });
});
