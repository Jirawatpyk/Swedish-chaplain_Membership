/**
 * T030 — Invoice state machine tests.
 * Exercises every transition in data-model.md § 3.1 plus invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  enforceOneMembershipLine,
  isTerminal,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import {
  makeInvoiceLine,
  asInvoiceLineId,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

describe('Invoice state machine', () => {
  describe('canTransition — legal transitions', () => {
    const LEGAL: ReadonlyArray<readonly [InvoiceStatus, InvoiceStatus]> = [
      ['draft', 'issued'],
      ['issued', 'paid'],
      ['issued', 'void'],
      ['paid', 'partially_credited'],
      ['paid', 'credited'],
      ['partially_credited', 'partially_credited'],
      ['partially_credited', 'credited'],
    ];

    it.each(LEGAL)('%s → %s is allowed', (from, to) => {
      expect(canTransition(from, to).ok).toBe(true);
    });
  });

  describe('canTransition — illegal transitions', () => {
    const ILLEGAL: ReadonlyArray<readonly [InvoiceStatus, InvoiceStatus]> = [
      ['draft', 'paid'],
      ['draft', 'void'],
      ['issued', 'draft'],
      ['paid', 'issued'],
      ['paid', 'void'], // void must happen before payment
      ['void', 'issued'],
      ['void', 'paid'],
      ['credited', 'issued'],
      ['credited', 'paid'],
      ['credited', 'partially_credited'],
    ];

    it.each(ILLEGAL)('%s → %s is rejected', (from, to) => {
      const r = canTransition(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['invalid_transition', 'terminal_state']).toContain(r.error.code);
      }
    });
  });

  describe('isTerminal', () => {
    it('void and credited are terminal', () => {
      expect(isTerminal('void')).toBe(true);
      expect(isTerminal('credited')).toBe(true);
    });
    it('other statuses are not terminal', () => {
      expect(isTerminal('draft')).toBe(false);
      expect(isTerminal('issued')).toBe(false);
      expect(isTerminal('paid')).toBe(false);
      expect(isTerminal('partially_credited')).toBe(false);
    });
  });

  describe('enforceOneMembershipLine', () => {
    const mkLine = (kind: 'membership_fee' | 'registration_fee', pos = 1): InvoiceLine => {
      const r = makeInvoiceLine({
        lineId: asInvoiceLineId(`line-${pos}-${kind}`),
        kind,
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership',
        unitPrice: Money.fromTHB(1000),
        quantity: '1.0000',
        proRateFactor: kind === 'membership_fee' ? '1.0000' : null,
        position: pos,
      });
      if (!r.ok) throw new Error('mkLine failed in test setup');
      return r.value;
    };

    it('accepts exactly 1 membership line', () => {
      const r = enforceOneMembershipLine([mkLine('membership_fee')]);
      expect(r.ok).toBe(true);
    });

    it('accepts 1 membership + 1 registration', () => {
      const r = enforceOneMembershipLine([mkLine('membership_fee', 1), mkLine('registration_fee', 2)]);
      expect(r.ok).toBe(true);
    });

    it('rejects 0 membership', () => {
      const r = enforceOneMembershipLine([mkLine('registration_fee')]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('no_membership_line');
    });

    it('rejects multiple membership', () => {
      const r = enforceOneMembershipLine([mkLine('membership_fee', 1), mkLine('membership_fee', 2)]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('multiple_membership_lines');
    });
  });
});
