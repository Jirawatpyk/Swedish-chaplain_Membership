/**
 * T031 — InvoiceLine unit tests — covers all error branches.
 */
import { describe, expect, it } from 'vitest';
import {
  makeInvoiceLine,
  asInvoiceLineId,
  type InvoiceLineId,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const lineId: InvoiceLineId = asInvoiceLineId('line-1');

describe('makeInvoiceLine', () => {
  it('builds a membership line with pro-rate factor', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership',
      unitPrice: Money.fromTHB(1000),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      position: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('membership_fee');
      expect(r.value.total.toString()).toBe('1000.00 THB');
    }
  });

  it('builds a registration line without pro-rate', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'registration_fee',
      descriptionTh: 'ค่าลงทะเบียน',
      descriptionEn: 'Registration',
      unitPrice: Money.fromTHB(500),
      quantity: '1.0000',
      proRateFactor: null,
      position: 2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.total.toString()).toBe('500.00 THB');
  });

  it('rejects empty TH description', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'registration_fee',
      descriptionTh: '   ',
      descriptionEn: 'Registration',
      unitPrice: Money.fromTHB(100),
      quantity: '1.0000',
      proRateFactor: null,
      position: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('description_empty');
  });

  it('rejects empty EN description (hits the SECOND branch)', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'registration_fee',
      descriptionTh: 'ค่าลงทะเบียน',
      descriptionEn: '   ',
      unitPrice: Money.fromTHB(100),
      quantity: '1.0000',
      proRateFactor: null,
      position: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('description_empty');
      if (r.error.code === 'description_empty') expect(r.error.field).toBe('en');
    }
  });

  it('rejects non-positive quantity', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'registration_fee',
      descriptionTh: 'x',
      descriptionEn: 'x',
      unitPrice: Money.fromTHB(100),
      quantity: '0',
      proRateFactor: null,
      position: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('quantity_not_positive');
  });

  it('rejects NaN quantity', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'registration_fee',
      descriptionTh: 'x',
      descriptionEn: 'x',
      unitPrice: Money.fromTHB(100),
      quantity: 'abc',
      proRateFactor: null,
      position: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('quantity_not_positive');
  });

  it('rejects membership_fee without pro_rate_factor', () => {
    const r = makeInvoiceLine({
      lineId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership',
      unitPrice: Money.fromTHB(1000),
      quantity: '1.0000',
      proRateFactor: null,
      position: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('pro_rate_factor_required_for_membership');
  });
});
