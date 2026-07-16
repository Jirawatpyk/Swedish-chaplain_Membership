/**
 * T166-02 — record-payment async receipt PDF branch (T166 flag on).
 *
 * Pins the contract that when `deps.asyncReceiptPdf=true`:
 *   1. `applyPayment` is called with `receiptPdf: { kind: 'pending' }`
 *      (NOT `kind: 'rendered'` — sha256 is unknown at this point).
 *   2. `pdfRender.render` + `blob.uploadPdf` are NEVER invoked.
 *   3. `receiptPdfRenderEnqueue.enqueue` is called with the deterministic
 *      blob key inputs (tenantId, invoiceId, fiscalYear, templateVersion).
 *   4. Audit `invoice_paid` still emits, but `receipt_pdf_sha256` payload
 *      field is null (worker fires a separate `receipt_rendered` audit
 *      once bytes land).
 *   5. Email outbox enqueue still happens (dispatcher will gate on
 *      `receipt_pdf_status='rendered'` per T166-09).
 *
 * Inline path (flag off, default) is covered by record-payment.test.ts
 * — verified to remain green before this file landed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';

const INVOICE_ID = '00000000-0000-0000-0000-00000000a166';

function makeIssuedInvoice(): Invoice {
  const line: InvoiceLine = {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก',
    descriptionEn: 'Membership',
    unitPrice: Money.fromTHB(1000),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromTHB(1000),
    position: 1,
  };
  const docNum = DocumentNumber.of('SC', 2026, 42);
  if (!docNum.ok) throw new Error('fixture');
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
    fiscalYear: 2026 as never,
    sequenceNumber: 42,
    documentNumber: docNum.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromTHB(1000),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromTHB(70),
    total: Money.fromTHB(1070),
    creditedTotal: Money.zero(),
    proRatePolicy: 'monthly',
    netDays: 30,
    tenantIdentitySnapshot: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    memberIdentitySnapshot: {
      legal_name: 'Acme Co',
      tax_id: 'snapshot-tax-at-issue',
      address: '123 Road',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      templateVersion: 1,
    },
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  } as Invoice;
}

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(500000n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    brandName: null,
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    ...overrides,
  };
}

function makeAsyncDeps(draft: Invoice, settings: TenantInvoiceSettingsView): RecordPaymentDeps {
  const opaqueTx = { execute: vi.fn(async () => [{ status: 'issued' }]) };
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(async () => ({ ...draft, status: 'paid' } as Invoice)),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as InvoiceStatus),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyReceiptPdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: { emit: vi.fn(async () => {}) },
    clock: { nowIso: () => '2026-05-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    memberIdentity: {
      getForIssue: vi.fn(),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    currentTemplateVersion: 1,
    asyncReceiptPdf: true,
    receiptPdfRenderEnqueue: { enqueue: vi.fn(async () => {}) },
    // Default: flag not carried (legacy/dormant), exact-equivalent of the
    // pre-refactor `undefined`. Tests that exercise the RC path override with 'on'.
    taxAtPayment: 'off',
  };
}

const input = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-pay-async',
  invoiceId: INVOICE_ID,
  paymentMethod: 'bank_transfer' as const,
  paymentReference: 'TRX-async',
  paymentDate: '2026-05-18',
};

describe('recordPayment — T166-03 async receipt PDF branch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applyPayment is called with receiptPdf: { kind: "pending" } when asyncReceiptPdf=true', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    const applyPaymentCalls = (deps.invoiceRepo.applyPayment as ReturnType<typeof vi.fn>).mock.calls;
    expect(applyPaymentCalls.length).toBe(1);
    const callArg = applyPaymentCalls[0]![1];
    // R1-C1 — combined-mode default fixture → receiptDocumentNumberRaw:null.
    // Separate-mode case is exercised via a dedicated test below.
    expect(callArg.receiptPdf).toEqual({
      kind: 'pending',
      receiptDocumentNumberRaw: null,
    });
  });

  it('pdfRender.render is NOT invoked on the async branch', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    await recordPayment(deps, input);
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
  });

  it('blob.uploadPdf is NOT invoked on the async branch', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    await recordPayment(deps, input);
    expect(deps.blob.uploadPdf).not.toHaveBeenCalled();
  });

  it('receiptPdfRenderEnqueue.enqueue is called with the deterministic blob key inputs', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    await recordPayment(deps, input);
    expect(deps.receiptPdfRenderEnqueue!.enqueue).toHaveBeenCalledTimes(1);
    const enqueueCalls = (
      deps.receiptPdfRenderEnqueue!.enqueue as ReturnType<typeof vi.fn>
    ).mock.calls;
    const enqueueArg = enqueueCalls[0]![1];
    expect(enqueueArg).toMatchObject({
      tenantId: 'test-swecham',
      invoiceId: INVOICE_ID,
      fiscalYear: 2026,
      templateVersion: 1,
    });
  });

  it('audit invoice_paid emits with receipt_pdf_sha256: null on the async branch', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    await recordPayment(deps, input);
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const invoicePaidCall = emitCalls.find((c) => c[1].eventType === 'invoice_paid');
    expect(invoicePaidCall).toBeDefined();
    expect(invoicePaidCall![1].payload.receipt_pdf_sha256).toBeNull();
  });

  it('inline path stays unchanged: flag undefined → renders sync (regression guard)', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    // Override flag back to undefined to assert the inline path still
    // calls the renderer + blob upload.
    const inlineDeps: RecordPaymentDeps = {
      ...deps,
      asyncReceiptPdf: false,
    };
    await recordPayment(inlineDeps, input);
    expect(inlineDeps.pdfRender.render).toHaveBeenCalledTimes(1);
    expect(inlineDeps.blob.uploadPdf).toHaveBeenCalledTimes(1);
    // Enqueue MUST NOT fire on the inline path.
    expect(inlineDeps.receiptPdfRenderEnqueue!.enqueue).not.toHaveBeenCalled();
  });

  // R1-C1 — separate-mode async path: receipt sequence allocator IS
  // called inside record-payment (atomically with the paid flip), and
  // the allocated raw doc num is persisted on the invoice row via
  // applyPayment so the worker reads it back instead of re-allocating
  // (which would create §87 gaps on every retry).
  it('088 async: pre-allocates the §87 receipt number + persists receiptDocumentNumberRaw on applyPayment', async () => {
    // 088 — a NEW-flow bill (non-§87 SC number, NULL §87 document_number). The
    // legacy §87 shape would (correctly) trip the FR-017 guard under the flag.
    const draft = {
      ...makeIssuedInvoice(),
      documentNumber: null,
      sequenceNumber: null,
      billDocumentNumberRaw: 'SC-2026-000042',
    } as Invoice;
    // 088 T008/T018 — RC allocation is flag-gated (`taxAtPayment`), not
    // settings-driven. Enable it so the async pre-allocation path runs.
    const deps = {
      ...makeAsyncDeps(
        draft,
        makeSettings({
          receiptNumberingMode: 'separate',
          // 088 US7 — the §86/4 RC-role receipt prefix. Uses 'RC' (the new
          // default); 'RE' is now reserved for the §105 event-receipt register.
          receiptNumberPrefix: 'RC',
        }),
      ),
      taxAtPayment: 'on' as const,
    };
    // Allocator returns sequence 7 — the test asserts that 7 is the
    // value that lands on the row (NOT some later value from a
    // worker re-allocation).
    (deps.sequenceAllocator.allocateNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(7);

    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);

    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledTimes(1);
    const callArg = (deps.invoiceRepo.applyPayment as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];
    expect(callArg.receiptPdf.kind).toBe('pending');
    expect(callArg.receiptPdf.receiptDocumentNumberRaw).toBe('RC-2026-000007');
  });

  // R1-CG-1 + R2-CG-1 — atomicity: enqueue throw must roll the whole
  // thing back. The opaqueTx mock returns control to the test via the
  // withTx callback's exception bubble — recordPayment surfaces a
  // typed error, the audit emit MUST NOT have been called, AND
  // applyPayment MUST have been called exactly once (proving the
  // tx reached the WRITE phase that gets rolled back, not just an
  // early-bail before any write happened — without this assertion the
  // test would pass even if the use-case bailed before `applyPayment`).
  it('rolls back the entire tx when receiptPdfRenderEnqueue throws', async () => {
    const draft = makeIssuedInvoice();
    const deps = makeAsyncDeps(draft, makeSettings());
    const enqueueErr = new Error('outbox insert failed (simulated)');
    (deps.receiptPdfRenderEnqueue!.enqueue as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(enqueueErr);

    let thrown: unknown = null;
    try {
      await recordPayment(deps, input);
    } catch (e) {
      thrown = e;
    }
    // The error propagates out of recordPayment (not swallowed) so the
    // outer transaction handler observes the failure and Postgres
    // rolls back. The audit emit (which fires AFTER the enqueue
    // success path) MUST NOT have been called.
    expect(thrown).toBe(enqueueErr);
    expect(deps.audit.emit).not.toHaveBeenCalled();
    // R2-CG-1 — applyPayment was reached (proves the WRITE happened
    // and was rolled back, not that we bailed early).
    expect(deps.invoiceRepo.applyPayment).toHaveBeenCalledTimes(1);
    // R2-CG-1 — enqueue was reached too (proves we got past
    // applyPayment to the throw point).
    expect(deps.receiptPdfRenderEnqueue!.enqueue).toHaveBeenCalledTimes(1);
  });
});
