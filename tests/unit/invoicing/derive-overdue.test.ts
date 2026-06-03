/**
 * T109 unit tests — pure overdue derivation.
 *
 * Covers every branch of `computeIsOverdue`:
 *   1. status !== 'issued' → false (even if past due)
 *   2. dueDate === null     → false
 *   3. today (Bangkok) === dueDate → false (boundary: not overdue yet)
 *   4. today (Bangkok) < dueDate   → false (future due)
 *   5. today (Bangkok) > dueDate   → true  (overdue)
 *   6. Bangkok TZ crossover: UTC 17:00 Mar 30 == Bangkok 00:00 Mar 31
 *      — an invoice due Mar 30 is OVERDUE by Bangkok midnight even
 *      though UTC still says Mar 30. Verifies the tz boundary.
 *
 * `deriveOverdue` is a thin wrapper — one happy-path test confirms
 * the decorated shape.
 *
 * `maybeEmitOverdueDetected` is exercised via a stub port that records
 * calls; the real idempotency is covered by the live-Neon integration
 * test alongside this file.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  deriveOverdue,
  computeIsOverdue,
  maybeEmitOverdueDetected,
} from '@/modules/invoicing/application/use-cases/derive-overdue';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';

const INVOICE_UUID = '11111111-2222-4333-8444-555555555555';

function sha(): Sha256Hex {
  const r = Sha256Hex.parse('a'.repeat(64));
  if (!r.ok) throw new Error('bad fixture hash');
  return r.value;
}

function docNum(): DocumentNumber {
  const r = DocumentNumber.parse('INV-2026-000001');
  if (!r.ok) throw new Error('bad fixture doc number');
  return r.value;
}

function issuedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId(INVOICE_UUID),
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'u',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_00n),
    total: Money.fromSatangUnsafe(107_00n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: makeTenantIdentitySnapshot({
      legal_name_th: 'x',
      legal_name_en: 'x',
      tax_id: '0',
      address_th: 'x',
      address_en: 'x',
      logo_blob_key: null,
    }),
    memberIdentitySnapshot: makeMemberIdentitySnapshot({
      legal_name: 'x',
      tax_id: null,
      address: 'x',
      primary_contact_name: 'x',
      // L-03 — makeMemberIdentitySnapshot now validates; 'x@x.x' fails zod
      // `.email()` (TLD must be ≥2 chars). Use a valid e-mail.
      primary_contact_email: 'contact@example.com',
    }),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: { blobKey: 'k', sha256: sha(), templateVersion: 1 },
    receiptPdf: null,
    lines: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  } as Invoice;
}

describe('computeIsOverdue', () => {
  it('(1) non-issued statuses are never overdue, even when past due', () => {
    const inv = issuedInvoice({ status: 'paid', dueDate: '2026-01-01' });
    // nowUtcIso is way past dueDate but status='paid'
    expect(computeIsOverdue(inv, '2026-04-21T03:00:00Z')).toBe(false);
  });

  it('(2) null dueDate → never overdue (defensive)', () => {
    const inv = issuedInvoice({ dueDate: null });
    expect(computeIsOverdue(inv, '2026-04-21T03:00:00Z')).toBe(false);
  });

  it('(3) today (Bangkok) equal to dueDate → NOT yet overdue', () => {
    // dueDate=2026-04-30; nowUtc=2026-04-30T08:00Z == Bangkok Apr 30 15:00
    const inv = issuedInvoice({ dueDate: '2026-04-30' });
    expect(computeIsOverdue(inv, '2026-04-30T08:00:00Z')).toBe(false);
  });

  it('(4) today (Bangkok) before dueDate → not overdue', () => {
    const inv = issuedInvoice({ dueDate: '2026-04-30' });
    expect(computeIsOverdue(inv, '2026-04-01T03:00:00Z')).toBe(false);
  });

  it('(5) today (Bangkok) past dueDate → overdue', () => {
    const inv = issuedInvoice({ dueDate: '2026-04-30' });
    expect(computeIsOverdue(inv, '2026-05-01T03:00:00Z')).toBe(true);
  });

  it('(6) Bangkok TZ crossover — UTC still Mar 30 but Bangkok is Mar 31', () => {
    // dueDate=2026-03-30; nowUtc=2026-03-30T17:30Z == Bangkok Mar 31 00:30
    // Bangkok today (Mar 31) > dueDate (Mar 30) → overdue
    const inv = issuedInvoice({ dueDate: '2026-03-30' });
    expect(computeIsOverdue(inv, '2026-03-30T17:30:00Z')).toBe(true);
  });
});

describe('deriveOverdue', () => {
  it('decorates the invoice with isOverdue + preserves every other field', () => {
    const inv = issuedInvoice({ dueDate: '2026-04-01' });
    const decorated = deriveOverdue(inv, '2026-04-30T03:00:00Z');
    expect(decorated.isOverdue).toBe(true);
    expect(decorated.invoiceId).toBe(inv.invoiceId);
    expect(decorated.status).toBe(inv.status);
    expect(decorated.total).toBe(inv.total);
  });
});

describe('maybeEmitOverdueDetected', () => {
  it('skips emit when not overdue', async () => {
    const emit = vi.fn(async () => true);
    const inv = issuedInvoice({ dueDate: '2026-05-30' });
    const r = await maybeEmitOverdueDetected(
      { emitOverdueOnce: emit },
      inv,
      '2026-04-21T03:00:00Z',
      { userId: 'u', requestId: 'r' },
    );
    expect(r).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits when overdue and passes derived Bangkok date to the adapter', async () => {
    const emit = vi.fn(async () => true);
    const inv = issuedInvoice({ dueDate: '2026-04-01' });
    const r = await maybeEmitOverdueDetected(
      { emitOverdueOnce: emit },
      inv,
      '2026-04-21T03:00:00Z',
      { userId: 'u-actor', requestId: 'req-1' },
    );
    expect(r).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = (emit as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(payload.invoiceId).toBe(inv.invoiceId);
    expect(payload.memberId).toBe(inv.memberId);
    expect(payload.dueDate).toBe('2026-04-01');
    expect(payload.bangkokLocalDate).toBe('2026-04-21');
    expect(payload.actorUserId).toBe('u-actor');
    expect(payload.requestId).toBe('req-1');
  });

  it('propagates adapter "duplicate" response (false) without throwing', async () => {
    const emit = vi.fn(async () => false);
    const inv = issuedInvoice({ dueDate: '2026-04-01' });
    const r = await maybeEmitOverdueDetected(
      { emitOverdueOnce: emit },
      inv,
      '2026-04-21T03:00:00Z',
      { userId: 'u', requestId: null },
    );
    expect(r).toBe(false);
  });
});
