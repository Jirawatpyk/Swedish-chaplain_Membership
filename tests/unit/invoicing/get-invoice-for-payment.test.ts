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
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';

/** A real §87 document number VO for the legacy-issued-row fixtures. */
function docNum(raw = 'SC-2026-000007'): DocumentNumber {
  const r = DocumentNumber.parse(raw);
  if (!r.ok) throw new Error('docNum fixture failed');
  return r.value;
}

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
      taxAtPayment: 'off',
      reconciliationPath: true,
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
      taxAtPayment: 'off',
      reconciliationPath: true,
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
      taxAtPayment: 'off',
      reconciliationPath: true,
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
      taxAtPayment: 'off',
      reconciliationPath: true,
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
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_payable');
  });
});

// ---------------------------------------------------------------------------
// REMOVE-WITH-064-REMEDIATION — S0 money-trap guard. A LEGACY pre-064
// issued no-TIN EVENT invoice (matched member, so portal-visible AND
// member-payable) must NOT be online-payable: its issue-time PDF already
// IS the buyer's §105 ใบเสร็จรับเงิน. Letting Stripe capture money against
// it strands the funds — recordPayment rejects the webhook-side flip with
// `legacy_no_tin_event_needs_remediation` (permanent, no auto-refund), so
// the payment succeeds processor-side while the invoice stays `issued`.
// Block at the payability read so the PI is never created. Delete this
// block with the master removal checklist in record-payment.ts.
// ---------------------------------------------------------------------------
const SIMULATED_NO_TIN_SNAPSHOT = {
  legal_name: 'Somchai Guest (SIMULATED)',
  tax_id: null,
  address: '123 Demo Road, Bangkok 10110',
  primary_contact_name: 'Somchai Guest',
  primary_contact_email: 'somchai.guest@example.com',
  member_number: null,
  member_number_display: null,
};

describe('getInvoiceForPayment — REMOVE-WITH-064-REMEDIATION legacy no-TIN event guard', () => {
  it('rejects a matched-member ISSUED event invoice whose buyer snapshot has no TIN', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      invoiceSubject: 'event',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(25_000n),
      memberIdentitySnapshot: SIMULATED_NO_TIN_SNAPSHOT,
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('legacy_no_tin_event_not_payable');
  });

  it('treats a whitespace-only tax_id as no-TIN (buyerHasTin trims)', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      invoiceSubject: 'event',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(25_000n),
      memberIdentitySnapshot: { ...SIMULATED_NO_TIN_SNAPSHOT, tax_id: '   ' },
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('legacy_no_tin_event_not_payable');
  });

  it('event invoice WITH a buyer TIN stays payable (064 bill-first path unaffected)', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      invoiceSubject: 'event',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(25_000n),
      memberIdentitySnapshot: {
        ...SIMULATED_NO_TIN_SNAPSHOT,
        tax_id: '1234567890123',
      },
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(true);
  });

  it('membership invoices are unaffected (guard is subject-scoped)', async () => {
    // A membership invoice can never legally lack a TIN (issue-invoice
    // gate), but the guard must still be subject-scoped so a data-edge
    // membership row stays on its existing behaviour.
    const invoice = makeInvoice({
      status: 'issued',
      invoiceSubject: 'membership',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(1_000_00n),
      memberIdentitySnapshot: SIMULATED_NO_TIN_SNAPSHOT,
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(true);
  });

  it('PAID no-TIN event invoices are not rejected by this guard (status-scoped — read/refund flows unaffected)', async () => {
    const invoice = makeInvoice({
      status: 'paid',
      invoiceSubject: 'event',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(25_000n),
      memberIdentitySnapshot: SIMULATED_NO_TIN_SNAPSHOT,
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// 088 SEC-MED — SYMMETRIC stranded-funds guard for the initiate side. A
// NEW-FLOW bill (NULL §87 `documentNumber` + non-§87 `billDocumentNumberRaw`,
// issued while FEATURE_088_TAX_AT_PAYMENT was ON) must NOT be online-payable
// after the flag is rolled back to OFF: without this guard the initiate side
// creates a Stripe PI, Stripe captures the money, then the webhook-side
// `recordPayment` guard refuses the flip (same `new_flow_bill_requires_flag_on`
// code, NO auto-refund) — captured-but-unappliable funds (S0). Two orthogonal
// INPUT axes gate it: the initiate path passes { taxAtPayment: 'on'/'off',
// reconciliationPath: false }; webhook-side reconciliation reads pass
// { taxAtPayment: <honest flag>, reconciliationPath: true } so they stay dormant.
// ---------------------------------------------------------------------------
describe('getInvoiceForPayment — 088 new-flow-bill flag-rollback guard', () => {
  it('flag OFF + a new-flow bill (issued, billDocumentNumberRaw set, documentNumber null) → new_flow_bill_requires_flag_on', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(1_070_00n),
      documentNumber: null,
      billDocumentNumberRaw: 'SC-2026-000001',
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('new_flow_bill_requires_flag_on');
  });

  it('flag ON + the SAME new-flow bill → payable (ok)', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(1_070_00n),
      documentNumber: null,
      billDocumentNumberRaw: 'SC-2026-000001',
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'on',
      reconciliationPath: false,
    });
    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('issued');
    expect(result.value.totalSatang).toBe(1_070_00n);
  });

  it('flag OFF + a LEGACY issued row (documentNumber set, billDocumentNumberRaw null) → unaffected (payable)', async () => {
    const invoice = makeInvoice({
      status: 'issued',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(1_070_00n),
      documentNumber: docNum(),
      billDocumentNumberRaw: null,
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      taxAtPayment: 'off',
      reconciliationPath: false,
    });
    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
  });

  // LOCK (b) — the reconciliationPath exemption. reconciliationPath:true +
  // taxAtPayment:'off' + a NEW-FLOW bill MUST stay payable (ok). This is the
  // webhook/confirm-payment read: the flow flag is genuinely OFF, but because it
  // is a reconciliation read the guard MUST NOT trip (the money is already
  // captured; refusing would strand it). If the `input.reconciliationPath !== true`
  // clause is ever removed from the guard, taxAtPayment:'off' + new-flow bill would
  // trip `new_flow_bill_requires_flag_on` → err → THIS TEST FAILS.
  it("reconciliationPath:true (webhook read) + flag OFF + a new-flow bill → payable (guard exempt on the reconciliation axis)", async () => {
    const invoice = makeInvoice({
      status: 'issued',
      memberId: 'mem-1',
      total: Money.fromSatangUnsafe(1_070_00n),
      documentNumber: null,
      billDocumentNumberRaw: 'SC-2026-000001',
    });
    const result = await getInvoiceForPayment(mkDeps(invoice), {
      tenantId: 'ten-1',
      invoiceId: '00000000-0000-0000-0000-000000000001',
      // Honest flow flag is OFF, but this is a reconciliation read → guard DORMANT.
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
  });
});
