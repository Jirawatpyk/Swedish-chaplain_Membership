/**
 * Spec 122 US8b follow-up — the refund dialog's "Credit note to be issued"
 * rows (boards `Admin-refund-full`, `Admin-refund-partial`).
 *
 * The preview must be the credit note the refund will actually issue:
 *   - the same F4 verdict the refund pre-flight reads (a §105 receipt or a
 *     voided invoice is WAIVED → no VAT rows; a blocked gate shows none), and
 *   - the same `calculateCreditNoteVat` split `issueCreditNote` applies, per
 *     note — there is no "residual on the last note" rule, so the final
 *     partial is rounded on its own exactly like the server does.
 */
import { describe, expect, it, vi } from 'vitest';
import { previewRefundCreditNote } from '@/modules/invoicing/application/use-cases/preview-refund-credit-note';
import { calculateCreditNoteVat } from '@/modules/invoicing/domain/policies/calculate-credit-note-vat';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { GetInvoiceDeps } from '@/modules/invoicing/application/use-cases/get-invoice';

const TOTAL = 3_852_000n;
const VAT = 252_000n;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('inv-1'),
    memberId: 'm-1',
    planId: 'p',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'paid',
    draftByUserId: 'u',
    fiscalYear: null,
    sequenceNumber: null,
    documentNumber: null,
    issueDate: null,
    dueDate: null,
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(TOTAL - VAT),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(VAT),
    total: Money.fromSatangUnsafe(TOTAL),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: { legal_name: 'Acme AB', buyer_is_vat_registrant: true },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: 'rendered',
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function depsFor(invoice: Invoice | null): GetInvoiceDeps {
  return {
    invoiceRepo: { findById: vi.fn(async () => invoice) } as unknown as GetInvoiceDeps['invoiceRepo'],
  };
}

async function preview(invoice: Invoice | null, creditTotalSatang: bigint) {
  return previewRefundCreditNote(depsFor(invoice), {
    tenantId: 't',
    invoiceId: 'inv-1',
    creditTotalSatang,
  });
}

/** What `issueCreditNote` will compute for this amount (`issue-credit-note.ts` step E). */
function issuedSplit(invoice: Invoice, creditTotalSatang: bigint) {
  const r = calculateCreditNoteVat({
    creditTotal: Money.fromSatangUnsafe(creditTotalSatang),
    originalVat: invoice.vat!,
    originalTotal: invoice.total!,
  });
  if (!r.ok) throw new Error('fixture: split failed');
  return { netSatang: r.value.creditAmount.satang, vatSatang: r.value.vat.satang };
}

describe('previewRefundCreditNote', () => {
  it('a full refund previews the invoice VAT exactly (excl. VAT 36,000.00, VAT 2,520.00)', async () => {
    const r = await preview(makeInvoice(), TOTAL);
    expect(r).toEqual({
      ok: true,
      value: { kind: 'issue', netSatang: 3_600_000n, vatSatang: 252_000n, vatRateRaw: '0.0700' },
    });
  });

  it('a partial refund previews the proportional split the credit note will carry', async () => {
    const invoice = makeInvoice();
    const r = await preview(invoice, 535_000n);
    expect(r).toEqual({
      ok: true,
      value: { kind: 'issue', netSatang: 500_000n, vatSatang: 35_000n, vatRateRaw: '0.0700' },
    });
    expect(r.ok && r.value.kind === 'issue' && { netSatang: r.value.netSatang, vatSatang: r.value.vatSatang }).toEqual(
      issuedSplit(invoice, 535_000n),
    );
  });

  it('the final partial is rounded on its own, like the issued note — not invoice VAT less earlier notes', async () => {
    // 1,070.00 THB incl. 70.00 VAT, credited 333.33 + 333.33 already. Each
    // earlier note carried round(7,000 × 33,333 / 107,000) = 2,181 satang VAT.
    const invoice = makeInvoice({
      subtotal: Money.fromSatangUnsafe(100_000n),
      vat: Money.fromSatangUnsafe(7_000n),
      total: Money.fromSatangUnsafe(107_000n),
      creditedTotal: Money.fromSatangUnsafe(66_666n),
      status: 'partially_credited',
    });
    const r = await preview(invoice, 40_334n);
    // round(7,000 × 40,334 / 107,000) = round(2,638.67) = 2,639 — NOT the
    // 7,000 − 2 × 2,181 = 2,638 a residual rule would give.
    expect(r).toEqual({
      ok: true,
      value: { kind: 'issue', netSatang: 37_695n, vatSatang: 2_639n, vatRateRaw: '0.0700' },
    });
    expect(r.ok && r.value.kind === 'issue' && r.value.vatSatang).toBe(issuedSplit(invoice, 40_334n).vatSatang);
  });

  it('a §105 receipt (event, buyer not VAT-registered) is waived — no credit note, no VAT', async () => {
    const r = await preview(
      makeInvoice({
        invoiceSubject: 'event',
        memberIdentitySnapshot: { legal_name: 'Walk-in Co', buyer_is_vat_registrant: false } as Invoice['memberIdentitySnapshot'],
      }),
      535_000n,
    );
    expect(r).toEqual({ ok: true, value: { kind: 'waived', reason: 'section_105_receipt' } });
  });

  it('an event invoice to a VAT-registered buyer still issues a credit note', async () => {
    const r = await preview(makeInvoice({ invoiceSubject: 'event' }), 535_000n);
    expect(r.ok && r.value.kind).toBe('issue');
  });

  // §105 is decided by the buyer's RECORDED registrant flag for a member, and
  // by TIN presence only for a walk-in (no members row) — document-kind.ts.
  it('a walk-in event buyer with a 13-digit TIN gets a credit note', async () => {
    const r = await preview(
      makeInvoice({
        invoiceSubject: 'event',
        memberId: null,
        memberIdentitySnapshot: { legal_name: 'Walk-in Co', tax_id: '0105551234567' } as Invoice['memberIdentitySnapshot'],
      }),
      535_000n,
    );
    expect(r.ok && r.value.kind).toBe('issue');
  });

  it('a walk-in event buyer without a TIN holds a §105 receipt — waived', async () => {
    const r = await preview(
      makeInvoice({
        invoiceSubject: 'event',
        memberId: null,
        memberIdentitySnapshot: { legal_name: 'Walk-in Person', tax_id: '' } as Invoice['memberIdentitySnapshot'],
      }),
      535_000n,
    );
    expect(r).toEqual({ ok: true, value: { kind: 'waived', reason: 'section_105_receipt' } });
  });

  it('a membership invoice to a non-registrant is a §86/4 document — it still gets a credit note (066)', async () => {
    const r = await preview(
      makeInvoice({
        memberIdentitySnapshot: { legal_name: 'Small Co', buyer_is_vat_registrant: false } as Invoice['memberIdentitySnapshot'],
      }),
      535_000n,
    );
    expect(r.ok && r.value.kind).toBe('issue');
  });

  it('a zero-rated (§80/1(5)) invoice previews VAT 0 at its stored 0.0000 rate', async () => {
    const r = await preview(
      makeInvoice({
        subtotal: Money.fromSatangUnsafe(TOTAL),
        vat: Money.zero(),
        vatRate: VatRate.ofUnsafe('0.0000'),
        vatTreatment: 'zero_rated_80_1_5',
      } as Partial<Invoice>),
      535_000n,
    );
    expect(r).toEqual({
      ok: true,
      value: { kind: 'issue', netSatang: 535_000n, vatSatang: 0n, vatRateRaw: '0.0000' },
    });
  });

  it('a fully credited invoice is blocked', async () => {
    const r = await preview(makeInvoice({ status: 'credited', creditedTotal: Money.fromSatangUnsafe(TOTAL) }), 1n);
    expect(r).toEqual({ ok: true, value: { kind: 'blocked' } });
  });

  it('a voided invoice is waived', async () => {
    const r = await preview(makeInvoice({ status: 'void' }), 535_000n);
    expect(r).toEqual({ ok: true, value: { kind: 'waived', reason: 'invoice_voided' } });
  });

  it('a blocked gate (receipt still rendering) previews no credit note', async () => {
    const r = await preview(makeInvoice({ receiptPdfStatus: 'pending' }), 535_000n);
    expect(r).toEqual({ ok: true, value: { kind: 'blocked' } });
  });

  it('a missing identity snapshot is blocked, never waived', async () => {
    const r = await preview(makeInvoice({ invoiceSubject: 'event', memberIdentitySnapshot: null }), 535_000n);
    expect(r).toEqual({ ok: true, value: { kind: 'blocked' } });
  });

  it('an amount above the un-credited headroom is refused, as issueCreditNote would', async () => {
    const r = await preview(makeInvoice({ creditedTotal: Money.fromSatangUnsafe(535_000n) }), TOTAL);
    expect(r).toEqual({ ok: false, error: { code: 'exceeds_remainder', remainingSatang: TOTAL - 535_000n } });
  });

  it('not found', async () => {
    expect(await preview(null, 535_000n)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('an issuable invoice without money fields is corrupt, not a zero split', async () => {
    const r = await preview(makeInvoice({ vat: null }), 535_000n);
    expect(r).toEqual({ ok: false, error: { code: 'invoice_data_corrupt' } });
  });
});
