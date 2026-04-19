/**
 * T030 — Invoice state machine tests.
 * Exercises every transition in data-model.md § 3.1 plus invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  asInvoiceId,
  assertSnapshotsSet,
  canTransition,
  enforceOneMembershipLine,
  isTerminal,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import {
  makeInvoiceLine,
  asInvoiceLineId,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

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

  describe('asInvoiceId branding', () => {
    it('brands a raw string', () => {
      const id = asInvoiceId('abc-123');
      expect(id).toBe('abc-123');
    });
  });

  describe('assertSnapshotsSet — every missing-field branch', () => {
    const fullSnapshot: Invoice = {
      tenantId: 't',
      invoiceId: asInvoiceId('i'),
      memberId: 'm',
      planId: 'p',
      planYear: 2026,
      status: 'issued',
      draftByUserId: 'u',
      fiscalYear: null,
      sequenceNumber: null,
      documentNumber: null,
      issueDate: null,
      dueDate: null,
      paidAt: null,
      voidedAt: null,
      currency: 'THB',
      subtotal: Money.fromSatangUnsafe(1000),
      vatRate: VatRate.ofUnsafe('0.0700'),
      vat: Money.fromSatangUnsafe(70),
      total: Money.fromSatangUnsafe(1070),
      creditedTotal: Money.zero(),
      proRatePolicy: null,
      netDays: null,
      tenantIdentitySnapshot: { legal_name_th: 'x', legal_name_en: 'x', tax_id: '0', address_th: 'a', address_en: 'a', logo_blob_key: null },
      memberIdentitySnapshot: { legal_name: 'm', tax_id: null, address: 'a', primary_contact_name: 'n', primary_contact_email: 'e' },
      paymentMethod: null,
      paymentReference: null,
      paymentNotes: null,
      paymentRecordedByUserId: null,
      voidReason: null,
      voidedByUserId: null,
      autoEmailOnIssue: null,
      pdf: {
        blobKey: 'key',
        sha256: Sha256Hex.ofUnsafe('0'.repeat(64)),
        templateVersion: 1,
      },
      lines: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('ok when all set', () => {
      expect(assertSnapshotsSet(fullSnapshot).ok).toBe(true);
    });

    it.each([
      ['subtotal', { subtotal: null }],
      ['vatRate', { vatRate: null }],
      ['tenantIdentitySnapshot', { tenantIdentitySnapshot: null }],
      ['memberIdentitySnapshot', { memberIdentitySnapshot: null }],
      ['pdf', { pdf: null }],
    ])('reports missing_snapshot field=%s', (field, override) => {
      const inv = { ...fullSnapshot, ...(override as Partial<Invoice>) };
      const r = assertSnapshotsSet(inv);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('missing_snapshot');
        expect((r.error as { field: string }).field).toBe(field);
      }
    });
  });
});
