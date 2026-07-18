/**
 * 088-invoice-tax-flow-redesign — T013 [US1] Contract test for
 * pay-and-record-payment per
 * `specs/088-invoice-tax-flow-redesign/contracts/pay-and-record-payment.md`.
 *
 * Asserts the CONTRACT of `recordPayment` under FEATURE_088_TAX_AT_PAYMENT:
 *
 *   flag ON — the single §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน is minted AT payment:
 *     • the §87 `RC` receipt number is allocated in-tx from the `receipt`
 *       stream (§78/1 tax point) with the PAYMENT-date fiscal year (trap G);
 *     • the receipt PDF is dated at the payment date (D7) as `receipt_combined`;
 *     • a `tax_receipt_issued` audit event fires (SC-001), distinct from
 *       `invoice_paid`, carrying the RC number + member_id (F3 timeline);
 *     • `receipt_document_number_raw` is persisted onto the row.
 *   flag OFF — the legacy flow reuses the issue-time §87 invoice number as the
 *     receipt: NO second §87 number is allocated and NO `tax_receipt_issued`
 *     fires (one §86/4 per sale in both flows).
 *
 * Use-case-level contract (mocked ports); live-Neon end-to-end proof is
 * `tests/integration/invoicing/bill-to-receipt.integration.test.ts` (T014).
 */
import { describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  recordPayment,
  type RecordPaymentDeps,
} from '@/modules/invoicing/application/use-cases/record-payment';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import type { TaxAtPaymentFlag } from '@/modules/invoicing/domain/tax-at-payment-flag';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { F4AuditEvent } from '@/modules/invoicing/application/ports/audit-port';
import { membershipAccessStub } from '../../helpers/membership-access-stub';

const INVOICE_ID = '08800000-0000-4000-8000-0000000000bb';

/** An issued membership row. `legacy=true` carries the §87 invoice number
 * (pre-088 / flag-off); `legacy=false` is the new-flow bill (non-§87 SC). */
function issuedMembership(legacy: boolean): Invoice {
  const line: InvoiceLine = {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก',
    descriptionEn: 'Membership',
    unitPrice: Money.fromTHB(12000),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromTHB(12000),
    position: 1,
  };
  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'issued',
    draftByUserId: 'actor-user',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: legacy ? 42 : null,
    documentNumber: legacy
      ? ({ raw: 'SC-2026-000042' } as unknown as Invoice['documentNumber'])
      : null,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromTHB(12000),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromTHB(840),
    total: Money.fromTHB(12840),
    creditedTotal: Money.zero(),
    proRatePolicy: 'monthly',
    netDays: 30,
    tenantIdentitySnapshot: Object.freeze({
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0994000187203',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    }),
    memberIdentitySnapshot: Object.freeze({
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: '123 Road, Bangkok',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    }),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: false,
    pdf: {
      blobKey: 'k',
      sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      templateVersion: 4,
    },
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: legacy ? null : 'SC-2026-000042',
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  } as Invoice;
}

function settings(): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(0n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberPrefix: 'RC',
    receiptNumberingMode: 'separate',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: false,
    brandName: null,
    identity: Object.freeze({
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0994000187203',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    }),
  };
}

interface Cap {
  renderInputs: PdfRenderInput[];
  applyPaymentInputs: Array<Record<string, unknown>>;
  auditEvents: Array<F4AuditEvent & { tenantId: string }>;
  allocateCalls: Array<{ documentType: string; fiscalYear: number }>;
}

function makeDeps(taxAtPayment: TaxAtPaymentFlag, legacy: boolean, cap: Cap): RecordPaymentDeps {
  const loaded = issuedMembership(legacy);
  return {
    membershipAccess: membershipAccessStub(), // 066 §4.4(1)
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(Symbol('tx'))),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => loaded),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      listSupersedableMembershipBills: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(async (_tx, input: Record<string, unknown>) => {
        cap.applyPaymentInputs.push(input);
        return { ...loaded, status: 'paid' as InvoiceStatus, paidAt: '2026-05-20T03:00:00Z' } as Invoice;
      }),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyReceiptPdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings()),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async (_tx, i: { documentType: string; fiscalYear: number }) => {
        cap.allocateCalls.push({ documentType: i.documentType, fiscalYear: i.fiscalYear });
        return 7;
      }),
    },
    pdfRender: {
      render: vi.fn(async (i: PdfRenderInput) => {
        cap.renderInputs.push(i);
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), sha256: Sha256Hex.ofUnsafe('c'.repeat(64)) };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
    audit: {
      emit: vi.fn(async (_tx, e: F4AuditEvent & { tenantId: string }) => {
        cap.auditEvents.push(e);
      }),
    },
    clock: { nowIso: () => '2026-05-20T03:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    memberIdentity: {
      getForIssue: vi.fn(),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    currentTemplateVersion: 4,
    taxAtPayment,
  };
}

function emptyCap(): Cap {
  return { renderInputs: [], applyPaymentInputs: [], auditEvents: [], allocateCalls: [] };
}

const input = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-pay-1',
  invoiceId: INVOICE_ID,
  paymentMethod: 'bank_transfer' as const,
  paymentDate: '2026-05-20',
};

describe('record-payment contract (088 US1) — §86/4 RC receipt at payment', () => {
  it('flag ON — mints the §87 RC number from the `receipt` stream (payment-date FY)', async () => {
    const cap = emptyCap();
    const r = await recordPayment(makeDeps('on', false, cap), input);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    expect(cap.allocateCalls).toHaveLength(1);
    expect(cap.allocateCalls[0]!.documentType).toBe('receipt');
    expect(cap.allocateCalls[0]!.fiscalYear).toBe(2026);
  });

  it('flag ON — receipt renders receipt_combined dated at the PAYMENT date (D7)', async () => {
    const cap = emptyCap();
    await recordPayment(makeDeps('on', false, cap), input);
    expect(cap.renderInputs).toHaveLength(1);
    expect(cap.renderInputs[0]!.kind).toBe('receipt_combined');
    expect(cap.renderInputs[0]!.issueDate).toBe('2026-05-20');
    expect(cap.renderInputs[0]!.documentNumber?.raw).toBe('RC-2026-000007');
  });

  it('flag ON — persists receipt_document_number_raw = RC on the row', async () => {
    const cap = emptyCap();
    await recordPayment(makeDeps('on', false, cap), input);
    const applied = cap.applyPaymentInputs[0]!;
    expect((applied.receiptPdf as { receiptDocumentNumberRaw: string }).receiptDocumentNumberRaw).toBe(
      'RC-2026-000007',
    );
  });

  it('flag ON — emits `tax_receipt_issued` (SC-001) in-tx with the RC number + member_id, distinct from invoice_paid', async () => {
    const cap = emptyCap();
    await recordPayment(makeDeps('on', false, cap), input);
    const taxReceipt = cap.auditEvents.find((e) => e.eventType === 'tax_receipt_issued');
    const paid = cap.auditEvents.find((e) => e.eventType === 'invoice_paid');
    expect(paid).toBeDefined();
    expect(taxReceipt).toBeDefined();
    const p = taxReceipt!.payload as Record<string, unknown>;
    expect(p.receipt_document_number_raw).toBe('RC-2026-000007');
    expect(p.member_id).toBe('member-1');
    expect(p.payment_date).toBe('2026-05-20');
  });

  it('flag OFF — legacy: reuses the §87 invoice number, mints NO second §87, fires NO tax_receipt_issued', async () => {
    const cap = emptyCap();
    const r = await recordPayment(makeDeps('off', true, cap), input);
    expect(r.ok).toBe(true);
    expect(cap.allocateCalls).toHaveLength(0);
    expect(cap.auditEvents.find((e) => e.eventType === 'tax_receipt_issued')).toBeUndefined();
    // Reuses the issue-time §87 number, dated at the invoice's issue date.
    expect(cap.renderInputs[0]!.documentNumber?.raw).toBe('SC-2026-000042');
    expect(cap.renderInputs[0]!.issueDate).toBe('2026-04-18');
    const applied = cap.applyPaymentInputs[0]!;
    expect((applied.receiptPdf as { receiptDocumentNumberRaw: string | null }).receiptDocumentNumberRaw).toBeNull();
  });
});
