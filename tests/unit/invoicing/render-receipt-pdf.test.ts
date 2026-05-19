/**
 * T166-04 — Unit tests for `renderReceiptPdf` use-case.
 *
 * Pins the contract for the async receipt PDF worker:
 *   1. Happy path: pending → rendered + bytes upload + audit emit.
 *   2. Idempotent: status='rendered' → no-op return ok (no render, no
 *      upload, no audit). At-least-once delivery safety.
 *   3. invalid_state: invoice not paid → typed err.
 *   4. invoice_not_found: missing row → typed err.
 *   5. settings_missing: tenant has no settings row → typed err.
 *   6. render_failed: pdfRender throws → applyReceiptPdfFailure called
 *      + typed err.
 *   7. blob_upload_failed: blob throws → applyReceiptPdfFailure called
 *      + typed err.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { renderReceiptPdf } from '@/modules/invoicing/application/use-cases/render-receipt-pdf';
import type { RenderReceiptPdfDeps } from '@/modules/invoicing/application/use-cases/render-receipt-pdf';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';

const INVOICE_ID = '00000000-0000-0000-0000-00000000a167';

function makePaidPendingInvoice(overrides: Partial<Invoice> = {}): Invoice {
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
    status: 'paid',
    draftByUserId: 'actor-user',
    fiscalYear: 2026 as never,
    sequenceNumber: 42,
    documentNumber: docNum.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: '2026-05-18T10:00:00Z',
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
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
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
    },
    paymentMethod: 'bank_transfer',
    paymentReference: 'TRX',
    paymentNotes: null,
    paymentRecordedByUserId: 'actor-user',
    paymentDate: '2026-05-18',
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      templateVersion: 1,
    },
    receiptPdf: null,
    receiptPdfStatus: 'pending',
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-05-18T10:00:00Z',
    ...overrides,
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
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    ...overrides,
  };
}

function makeDeps(
  invoice: Invoice | null,
  settings: TenantInvoiceSettingsView | null,
  overrides: Partial<RenderReceiptPdfDeps> = {},
): RenderReceiptPdfDeps {
  const opaqueTx = { execute: vi.fn(async () => []) };
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => invoice),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(async () =>
        invoice
          ? ({ ...invoice, receiptPdfStatus: 'rendered' } as Invoice)
          : (null as unknown as Invoice),
      ),
      applyReceiptPdfFailure: vi.fn(async () => ({
        kind: 'failed' as const,
        invoice: invoice
          ? ({ ...invoice, receiptPdfStatus: 'failed' } as Invoice)
          : (null as unknown as Invoice),
      })),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
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
    ...overrides,
  };
}

const input = {
  tenantId: 'test-swecham',
  invoiceId: INVOICE_ID,
  fiscalYear: 2026,
  templateVersion: 1,
  requestId: 'req-render',
};

describe('renderReceiptPdf — async worker callback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: pending → rendered + bytes upload + audit emit', async () => {
    const deps = makeDeps(makePaidPendingInvoice(), makeSettings());
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledTimes(1);
    expect(deps.blob.uploadPdf).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdf).toHaveBeenCalledTimes(1);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const rendered = auditCalls.find((c) => c[1].eventType === 'receipt_rendered');
    expect(rendered).toBeDefined();
    expect(rendered![1].payload.receipt_pdf_sha256).toBe('b'.repeat(64));
  });

  it('idempotent: status=rendered → no-op return ok (no render, no upload, no audit)', async () => {
    const deps = makeDeps(
      makePaidPendingInvoice({ receiptPdfStatus: 'rendered' }),
      makeSettings(),
    );
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.blob.uploadPdf).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyReceiptPdf).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('invalid_state: invoice not paid → typed err', async () => {
    const deps = makeDeps(
      makePaidPendingInvoice({ status: 'issued', receiptPdfStatus: null }),
      makeSettings(),
    );
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_state');
    }
  });

  it('invoice_not_found: missing row → typed err', async () => {
    const deps = makeDeps(null, makeSettings());
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
  });

  it('settings_missing: tenant has no settings row → typed err (early exit, no withTx)', async () => {
    const deps = makeDeps(makePaidPendingInvoice(), null);
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('settings_missing');
    expect(deps.invoiceRepo.withTx).not.toHaveBeenCalled();
  });

  it('render_failed: pdfRender throws → applyReceiptPdfFailure called + typed err', async () => {
    const deps = makeDeps(makePaidPendingInvoice(), makeSettings());
    (deps.pdfRender.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('render exploded'),
    );
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('render_failed');
    expect(deps.invoiceRepo.applyReceiptPdfFailure).toHaveBeenCalledTimes(1);
  });

  it('blob_upload_failed: blob throws → applyReceiptPdfFailure called + typed err', async () => {
    const deps = makeDeps(makePaidPendingInvoice(), makeSettings());
    (deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob exploded'),
    );
    const r = await renderReceiptPdf(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blob_upload_failed');
    expect(deps.invoiceRepo.applyReceiptPdfFailure).toHaveBeenCalledTimes(1);
  });

  // R3-C1 — race-won-by-success path (genuinely exercises C-NEW-1 fix).
  // Scenario: worker A loaded the row when status='pending', started
  // rendering, then encountered a transient failure (pdfRender throw).
  // Between A's load + A's failure-write, worker B finished + flipped
  // the row to 'rendered'. When A's catch block calls
  // applyReceiptPdfFailure, the impl detects status='rendered' and
  // returns kind='race_won_by_success' instead of overwriting the
  // healthy row. The use-case maps this to ok() so the dispatcher does
  // NOT bump attempts or schedule a retry — worker A's failure was
  // benign, worker B already produced a valid receipt PDF.
  it('R3-C1 race_won_by_success: render throws + applyReceiptPdfFailure returns race-won → use-case returns ok (NOT err)', async () => {
    const pendingInvoice = makePaidPendingInvoice();
    const renderedInvoice = {
      ...pendingInvoice,
      receiptPdfStatus: 'rendered' as const,
    } as Invoice;
    const deps = makeDeps(pendingInvoice, makeSettings());
    // Force the render path to throw (simulates worker A's render error).
    (deps.pdfRender.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('worker A render exploded'),
    );
    // Override applyReceiptPdfFailure to return race-won (simulates
    // the implementation detecting status='rendered' under the
    // ne(status,'rendered') guard's zero-row update + re-fetch path).
    (
      deps.invoiceRepo.applyReceiptPdfFailure as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      kind: 'race_won_by_success' as const,
      invoice: renderedInvoice,
    });

    const r = await renderReceiptPdf(deps, input);

    // ok() — race-won is treated as success (NOT err).
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.receiptPdfStatus).toBe('rendered');
    }
    // applyReceiptPdfFailure WAS called — proves we entered the catch
    // block (NOT the idempotent guard's early-exit). This is the
    // SECOND code path through the use-case for "already rendered" —
    // distinct from the line-127 guard which exits BEFORE rendering.
    expect(deps.invoiceRepo.applyReceiptPdfFailure).toHaveBeenCalledTimes(1);
  });

  // R3-C1 sibling: same code path but applyReceiptPdfFailure returns
  // kind='failed' (the normal failure path). Use-case must STILL
  // return err — only race-won maps to ok.
  it('R3-C1 normal failure: render throws + applyReceiptPdfFailure returns failed → use-case returns err (NOT ok)', async () => {
    const pendingInvoice = makePaidPendingInvoice();
    const deps = makeDeps(pendingInvoice, makeSettings());
    (deps.pdfRender.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('render exploded'),
    );
    // Default applyReceiptPdfFailure mock already returns kind='failed'
    // (set in makeDeps) — explicit here for clarity.
    (
      deps.invoiceRepo.applyReceiptPdfFailure as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      kind: 'failed' as const,
      invoice: { ...pendingInvoice, receiptPdfStatus: 'failed' } as Invoice,
    });

    const r = await renderReceiptPdf(deps, input);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render_failed');
    }
    expect(deps.invoiceRepo.applyReceiptPdfFailure).toHaveBeenCalledTimes(1);
  });
});
