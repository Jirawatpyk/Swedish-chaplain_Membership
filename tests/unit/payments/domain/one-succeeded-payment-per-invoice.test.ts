/**
 * T052 — One-succeeded-payment-per-invoice invariant unit tests.
 *
 * Confirms:
 *   - empty existing → ok
 *   - only pending/failed/canceled existing → ok (retry allowed)
 *   - any 'succeeded' lineage present → err with correct count
 *   - multiple succeeded existing → err with correct count
 *   - property: for every subset of PAYMENT_STATUSES, ok iff zero
 *     succeeded-lineage rows present
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  enforceOneSucceededPerInvoice,
  SUCCEEDED_LINEAGE,
} from '@/modules/payments/domain/invariants/one-succeeded-payment-per-invoice';
import {
  PAYMENT_STATUSES,
  type PaymentStatus,
} from '@/modules/payments/domain/payment';

describe('enforceOneSucceededPerInvoice', () => {
  it('ok on empty existing array', () => {
    expect(enforceOneSucceededPerInvoice([]).ok).toBe(true);
  });

  it('ok when only pending attempts exist (retry mid-flight)', () => {
    expect(enforceOneSucceededPerInvoice(['pending', 'pending']).ok).toBe(true);
  });

  it('ok when prior attempts failed or canceled (member retrying)', () => {
    expect(
      enforceOneSucceededPerInvoice(['failed', 'canceled', 'failed']).ok,
    ).toBe(true);
  });

  it('err when one succeeded attempt exists', () => {
    const r = enforceOneSucceededPerInvoice(['succeeded']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('duplicate_succeeded_payment');
    expect(r.error.existingSucceededCount).toBe(1);
  });

  it('err when partially_refunded exists (mid-refund lineage)', () => {
    const r = enforceOneSucceededPerInvoice(['partially_refunded']);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.existingSucceededCount).toBe(1);
  });

  it('err when refunded exists (terminal refunded lineage)', () => {
    const r = enforceOneSucceededPerInvoice(['refunded']);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.existingSucceededCount).toBe(1);
  });

  it('err with accurate count when multiple succeeded-lineage rows exist', () => {
    const r = enforceOneSucceededPerInvoice([
      'succeeded',
      'partially_refunded',
      'failed',
      'refunded',
      'pending',
    ]);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.existingSucceededCount).toBe(3);
  });

  it('SUCCEEDED_LINEAGE matches data-model.md § 2.5 terminal + intermediate refunded states', () => {
    expect([...SUCCEEDED_LINEAGE].sort()).toEqual(
      ['partially_refunded', 'refunded', 'succeeded'].sort(),
    );
  });

  // A.4 — `auto_refunded` (migration 0240) is a stale-invoice auto-refund
  // outcome reached directly from `pending`; it never implies the invoice
  // was settled via a succeeded charge, so it must NOT count toward the
  // one-succeeded-per-invoice invariant (a member can still retry payment
  // on an invoice whose prior attempt was auto-refunded).
  it('ok when auto_refunded exists (not in succeeded lineage)', () => {
    expect(enforceOneSucceededPerInvoice(['auto_refunded']).ok).toBe(true);
  });

  it('SUCCEEDED_LINEAGE does not include auto_refunded', () => {
    expect((SUCCEEDED_LINEAGE as readonly string[]).includes('auto_refunded')).toBe(
      false,
    );
  });
});

describe('enforceOneSucceededPerInvoice — properties', () => {
  const status = fc.constantFrom(...PAYMENT_STATUSES);

  it('ok iff zero succeeded-lineage rows present (property)', () => {
    fc.assert(
      fc.property(fc.array(status, { maxLength: 10 }), (arr) => {
        const succeededCount = arr.filter((s: PaymentStatus) =>
          (SUCCEEDED_LINEAGE as readonly string[]).includes(s),
        ).length;
        const result = enforceOneSucceededPerInvoice(arr);
        if (succeededCount === 0) return result.ok === true;
        if (result.ok) return false;
        return result.error.existingSucceededCount === succeededCount;
      }),
      { numRuns: 100 },
    );
  });
});
