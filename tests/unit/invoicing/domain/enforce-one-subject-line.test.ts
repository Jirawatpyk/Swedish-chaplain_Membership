/**
 * Task 2 (event-fee invoices) — `enforceOneSubjectLine` Domain unit tests.
 *
 * Subject-aware exactly-one-line invariant. The `'membership'` subject
 * MUST reproduce the legacy `enforceOneMembershipLine` error contract
 * (`Result<void, InvoiceTransitionError>` with `no_membership_line` /
 * `multiple_membership_lines`) so the Task 7 caller swap is
 * behaviour-preserving. The `'event'` subject mirrors the same shape
 * for `event_fee` lines (`no_event_fee_line` / `multiple_event_fee_lines`).
 *
 * Fixtures use the REAL `makeInvoiceLine` constructor (no hand-rolled
 * line shape) so the test exercises the actual `kind` discriminant.
 *
 * Authored RED-first 2026-06-04.
 */
import { describe, expect, it } from 'vitest';
import {
  enforceOneSubjectLine,
  type InvoiceTransitionError,
} from '@/modules/invoicing/domain/invoice';
import {
  makeInvoiceLine,
  asInvoiceLineId,
  type InvoiceLine,
  type InvoiceLineKind,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const mkLine = (kind: InvoiceLineKind, pos = 1): InvoiceLine => {
  const r = makeInvoiceLine({
    lineId: asInvoiceLineId(`line-${pos}-${kind}`),
    kind,
    descriptionTh: 'รายการ',
    descriptionEn: 'Line',
    unitPrice: Money.fromTHB(1000),
    quantity: '1.0000',
    // membership_fee requires a pro-rate factor; event/registration do not.
    proRateFactor: kind === 'membership_fee' ? '1.0000' : null,
    position: pos,
  });
  if (!r.ok) throw new Error('mkLine failed in test setup');
  return r.value;
};

/** Narrow helper so we can assert on `error.code` without a type cast. */
const errorCode = (
  r: { ok: true } | { ok: false; error: InvoiceTransitionError },
): string => {
  if (r.ok) throw new Error('expected err Result');
  return r.error.code;
};

describe('enforceOneSubjectLine — subject-aware exactly-one invariant', () => {
  describe("subject 'membership'", () => {
    it('accepts exactly one membership_fee line', () => {
      const r = enforceOneSubjectLine('membership', [mkLine('membership_fee')]);
      expect(r.ok).toBe(true);
    });

    it('accepts one membership_fee + one registration_fee', () => {
      const r = enforceOneSubjectLine('membership', [
        mkLine('membership_fee', 1),
        mkLine('registration_fee', 2),
      ]);
      expect(r.ok).toBe(true);
    });

    it('rejects zero membership_fee lines → no_membership_line', () => {
      const r = enforceOneSubjectLine('membership', [mkLine('registration_fee')]);
      expect(r.ok).toBe(false);
      expect(errorCode(r)).toBe('no_membership_line');
    });

    it('rejects multiple membership_fee lines → multiple_membership_lines (with count)', () => {
      const r = enforceOneSubjectLine('membership', [
        mkLine('membership_fee', 1),
        mkLine('membership_fee', 2),
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.code === 'multiple_membership_lines') {
        expect(r.error.count).toBe(2);
      } else {
        throw new Error('expected multiple_membership_lines with count');
      }
    });
  });

  describe("subject 'event'", () => {
    it('accepts exactly one event_fee line', () => {
      const r = enforceOneSubjectLine('event', [mkLine('event_fee')]);
      expect(r.ok).toBe(true);
    });

    it('rejects zero event_fee lines (a membership_fee line) → no_event_fee_line', () => {
      const r = enforceOneSubjectLine('event', [mkLine('membership_fee')]);
      expect(r.ok).toBe(false);
      expect(errorCode(r)).toBe('no_event_fee_line');
    });

    it('rejects multiple event_fee lines → multiple_event_fee_lines (with count)', () => {
      const r = enforceOneSubjectLine('event', [
        mkLine('event_fee', 1),
        mkLine('event_fee', 2),
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.code === 'multiple_event_fee_lines') {
        expect(r.error.count).toBe(2);
      } else {
        throw new Error('expected multiple_event_fee_lines with count');
      }
    });
  });
});
