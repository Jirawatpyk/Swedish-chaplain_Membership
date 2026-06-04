/**
 * Unit tests for `getInvoiceForPayment` — F5 → F4 bridge DTO use-case.
 *
 * Covers error paths that the processor-bridge integration test cannot
 * hit because `seedInvoice` always populates `totalSatang` (i.e. the
 * null-total and zero-total `not_payable` branches). Security-critical
 * payment-initiation path must have 100% branch coverage per
 * Constitution Principle II.
 */
import { describe, expect, it, vi } from 'vitest';
import { getInvoiceForPayment } from '@/modules/invoicing/application/use-cases/get-invoice-for-payment';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';

function makeInvoice(overrides: Partial<Invoice>): Invoice {
  return {
    tenantId: 'ten-1',
    invoiceId: asInvoiceId('00000000-0000-0000-0000-000000000001'),
    memberId: 'mem-1',
    planId: 'plan-1',
    planYear: 2026,
    status: 'draft',
    draftByUserId: 'user-1',
    fiscalYear: null,
    sequenceNumber: null,
    documentNumber: null,
    issueDate: null,
    dueDate: null,
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: null,
    vatRate: null,
    vat: null,
    total: null,
    creditedTotal: Money.fromSatangUnsafe(0n),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: null,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    ...overrides,
  } as Invoice;
}

const mkDeps = (invoice: Invoice | null) =>
  ({
    invoiceRepo: {
      findById: vi.fn().mockResolvedValue(invoice),
    },
  }) as unknown as Parameters<typeof getInvoiceForPayment>[0];

describe('getInvoiceForPayment — payability error paths', () => {
  it('returns not_payable when invoice.total is null (draft-no-snapshot)', async () => {
    const invoice = makeInvoice({ status: 'draft', total: null });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_payable');
    if (result.error.code !== 'not_payable') return;
    expect(result.error.status).toBe('draft');
  });

  it('returns not_payable when total.satang === 0n (100%-discounted)', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      total: Money.fromSatangUnsafe(0n),
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_payable');
  });

  it('returns ok with projected DTO when total > 0', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      total: Money.fromSatangUnsafe(1_000_00n),
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalSatang).toBe(1_000_00n);
    expect(result.value.status).toBe('issued');
    expect(result.value.memberId).toBe('mem-1');
    expect(result.value.tenantId).toBe('ten-1');
  });

  it('returns not_found when repo returns null', async () => {
    const result = await getInvoiceForPayment(mkDeps(null), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  // 054-event-fee-invoices (Task 8) — a NON-member EVENT invoice has
  // `memberId === null` but a payable `total`. The F5 → F4 payment bridge
  // binds a payment to a member for RLS (`payments.member_id` is NOT NULL),
  // so a null-member invoice is NOT yet online-payable. The use-case MUST
  // surface a typed `not_payable` at the boundary — NEVER pass a null
  // memberId downstream (that would be a DB NOT NULL crash, not a typed
  // error). This locks the access decision so F5 can never receive a null
  // memberId in the `ok` DTO.
  it('returns not_payable for a non-member EVENT invoice (memberId null) even when total > 0', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      memberId: null,
      total: Money.fromSatangUnsafe(25_000n),
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_payable');
  });
});
