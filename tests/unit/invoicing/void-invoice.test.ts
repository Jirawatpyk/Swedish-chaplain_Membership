/**
 * 064 W1 Fix 3 (S32 + S31) — void-invoice Application-layer unit tests.
 *
 * S32 — remediation void for NON-member event rows: `voidInvoice`
 * previously rejected EVERY `member_id IS NULL` row with
 * `no_snapshot_on_invoice`, which made the legacy no-TIN remediation
 * runbook's Step 2.1 ("void the issue-time pseudo-receipt") IMPOSSIBLE
 * to execute for non-member legacy rows. The guard is now
 * subject-aware (record-payment Task-8 parity): an EVENT row needs the
 * BUYER SNAPSHOT (already enforced by the completeness guard above),
 * not a member binding; a MEMBERSHIP row with a null member stays a
 * data-corruption reject.
 *
 * S31 — kind-true void re-render: the VOID overlay re-render passes
 * `voidUnderlyingKind: loaded.pdfDocKind ?? 'invoice'` so the template
 * titles the document by what the ORIGINAL actually was (a §105
 * ใบเสร็จรับเงิน original must not come back titled ใบกำกับภาษี).
 *
 * Until this file existed, void-invoice had integration coverage only
 * (tests/integration/invoicing/void-invoice.test.ts, membership rows).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { voidInvoice } from '@/modules/invoicing/application/use-cases/void-invoice';
import type { VoidInvoiceDeps } from '@/modules/invoicing/application/use-cases/void-invoice';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { InvoiceFixtureOverrides } from '../../helpers/invoice-fixture-overrides';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';

const INVOICE_ID = '00000000-0000-0000-0000-000000000099';
const OPAQUE_TX = Symbol('tx');

function docNumber(): NonNullable<Invoice['documentNumber']> {
  const r = DocumentNumber.of('SC', 2026, 7);
  if (!r.ok) throw new Error('fixture DocumentNumber failed');
  return r.value;
}

function makeMembershipLine(): InvoiceLine {
  return {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก ปี 2026',
    descriptionEn: 'Membership 2026',
    unitPrice: Money.fromSatangUnsafe(100_000n),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromSatangUnsafe(100_000n),
    position: 1,
  };
}

const SNAP_TENANT = Object.freeze({
  legal_name_th: 'หอการค้าจำลอง',
  legal_name_en: 'Simulated Chamber',
  tax_id: '0000000000000',
  address_th: 'กรุงเทพฯ',
  address_en: 'Bangkok',
  logo_blob_key: null,
});

/** SIMULATED membership buyer (fake TIN — never real PII). */
const SNAP_MEMBER = Object.freeze({
  legal_name: 'Simulated Void Co., Ltd.',
  tax_id: '1234512345123',
  address: '99/1 Simulated Rd, Bangkok',
  primary_contact_name: 'Sim Contact',
  primary_contact_email: 'sim.contact@void.test',
  member_number: null,
  member_number_display: null,
});

/** SIMULATED non-member NO-TIN buyer (legacy pre-064 shape). */
const SNAP_WALKIN = Object.freeze({
  legal_name: 'Simulated Walk-in Guest',
  tax_id: null,
  address: '50 Simulated Road, Bangkok',
  primary_contact_name: 'Sim Guest',
  primary_contact_email: 'sim.guest@void.test',
  member_number: null,
  member_number_display: null,
});

/** ISSUED membership invoice — the classic void target. */
function makeIssuedMembership(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'plan-1',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'issued',
    draftByUserId: 'actor-user',
    fiscalYear: 2026,
    sequenceNumber: 7,
    documentNumber: docNumber(),
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: SNAP_TENANT,
    memberIdentitySnapshot: SNAP_MEMBER,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: true,
    pdf: {
      blobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
      sha256: 'a'.repeat(64),
      templateVersion: 1,
    },
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    // 088 fields — complete the row so ROW-SHAPE dispatch reads real values
    // (a bare `as Invoice` cast leaves these `undefined`, which `!== null`
    // would mis-read as "set").
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [makeMembershipLine()],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
    // `Invoice` is a discriminated union; the flat spread cannot be
    // re-narrowed — assert at the factory boundary (repo convention).
  } as Invoice;
}

/** LEGACY pre-064 shape: ISSUED no-TIN EVENT row, non-member buyer. */
function makeLegacyNoTinEvent(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return makeIssuedMembership({
    invoiceSubject: 'event',
    memberId: null,
    planId: null,
    planYear: null,
    eventId: 'event-uuid-1',
    eventRegistrationId: 'reg-uuid-1',
    vatInclusive: true,
    memberIdentitySnapshot: SNAP_WALKIN,
    // The issue-time main PDF already IS the §105 ใบเสร็จรับเงิน.
    pdfDocKind: 'receipt_separate',
    lines: [
      {
        lineId: asInvoiceLineId('line-1'),
        kind: 'event_fee',
        descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
        descriptionEn: 'Event: Annual Gala (2026-09-10)',
        unitPrice: Money.fromSatangUnsafe(107_000n),
        quantity: '1.0000',
        proRateFactor: null,
        total: Money.fromSatangUnsafe(107_000n),
        position: 1,
      },
    ],
    ...overrides,
  });
}

const BILL_NO = 'SC-2026-000007';
const RC_NO = 'RC-2026-000042';
const RE_NO = 'RE-2026-000005';
const RECEIPT_BLOB_KEY = `invoicing/test-swecham/2026/${INVOICE_ID}_receipt_v8.pdf`;
const RECEIPT_ORIGINAL_SHA = 'd'.repeat(64);

/**
 * 088 T068 — new-flow ISSUED ใบแจ้งหนี้ bill (FEATURE_088_TAX_AT_PAYMENT on):
 * documentNumber NULL, bill number in `billDocumentNumberRaw`, ONE blob (the
 * bill), pdf_doc_kind 'invoice'. Void re-renders it under ใบแจ้งหนี้.
 */
function makeIssuedBill(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return makeIssuedMembership({
    status: 'issued',
    sequenceNumber: null,
    documentNumber: null,
    billDocumentNumberRaw: BILL_NO,
    pdfDocKind: 'invoice',
    ...overrides,
  });
}

/**
 * 088 T068 — PAID membership (record-payment separate-receipt path): the main
 * `pdf` is the ใบแจ้งหนี้ bill (SC), a DISTINCT `receiptPdf` blob holds the
 * §86/4 tax receipt (RC). Voiding stamps BOTH.
 */
function makePaidMembershipTwoBlob(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return makeIssuedMembership({
    status: 'paid',
    sequenceNumber: null,
    documentNumber: null,
    billDocumentNumberRaw: BILL_NO,
    receiptDocumentNumberRaw: RC_NO,
    pdfDocKind: 'invoice',
    paymentDate: '2026-05-01',
    receiptPdfStatus: 'rendered',
    receiptPdf: {
      blobKey: RECEIPT_BLOB_KEY,
      sha256: Sha256Hex.ofUnsafe(RECEIPT_ORIGINAL_SHA),
      templateVersion: 8,
    },
    ...overrides,
  });
}

/**
 * 088 T068 — PAID event-no-TIN §105 as-paid (β numbering): ONE blob (the main
 * pdf IS the §105 receipt), documentNumber NULL, RE number in
 * `receiptDocumentNumberRaw`, receiptPdf NULL. Voiding stamps its single blob.
 */
function makePaidAsPaidNoTinEvent(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return makeLegacyNoTinEvent({
    status: 'paid',
    sequenceNumber: null,
    documentNumber: null,
    receiptDocumentNumberRaw: RE_NO,
    pdfDocKind: 'receipt_separate',
    paymentDate: '2026-05-01',
    receiptPdfStatus: 'rendered',
    receiptPdf: null,
    ...overrides,
  });
}

function makeSettings(): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 500_000n as never,
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'separate',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    brandName: null,
    identity: SNAP_TENANT,
  };
}

function makeDeps(
  loaded: Invoice | null,
  overrides: Partial<VoidInvoiceDeps> = {},
): VoidInvoiceDeps {
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(OPAQUE_TX)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => loaded),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => loaded?.status ?? null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(async () => {}),
      applyReceiptPdfRegeneration: vi.fn(async () => {}),
      // Bug 10 — reconcile-marker repo methods (Phase-2 leg-split).
      markVoidPdfReconcilePending: vi.fn(async () => {}),
      clearVoidPdfReconcileMarker: vi.fn(async () => {}),
      bumpVoidPdfReconcileAttempts: vi.fn(async () => {}),
      parkVoidPdfReconcile: vi.fn(async () => {}),
      applyVoid: vi.fn(async () =>
        ({
          ...(loaded as Invoice),
          status: 'void',
          voidedAt: '2026-06-11T03:00:00Z',
          voidReason: 'unit void',
          voidedByUserId: 'actor-user',
        }) as Invoice,
      ),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    } as unknown as VoidInvoiceDeps['invoiceRepo'],
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => makeSettings()),
      upsert: vi.fn(),
      withTx: vi.fn(),
      getForUpdateInTx: vi.fn(),
      readSequencesInTx: vi.fn(),
    } as unknown as VoidInvoiceDeps['tenantSettingsRepo'],
    pdfRender: {
      // Kind-aware sha so a two-blob paid void yields DISTINCT bill vs receipt
      // hashes: the main bill/§86/4/§105 render (voidUnderlyingKind ≠
      // 'receipt_combined') → 'b'*64; the SEPARATE §86/4 receipt render
      // (voidUnderlyingKind === 'receipt_combined') → 'c'*64.
      render: vi.fn(async (input: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe(
          input.voidUnderlyingKind === 'receipt_combined'
            ? 'c'.repeat(64)
            : 'b'.repeat(64),
        ),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as unknown as VoidInvoiceDeps['blob'],
    audit: { emit: vi.fn(async () => {}) },
    clock: { nowIso: () => '2026-06-11T03:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    // Email-locale audit 2026-07-16 — default no stored preference (→ 'en').
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    // 8A — default: no refund in flight → the guard never fires on the existing
    // void happy paths. The guard test overrides with a positive count.
    pendingRefundGuard: {
      countPendingRefundsForInvoice: vi.fn(async () => 0),
    },
    ...overrides,
  };
}

const INPUT = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-1',
  invoiceId: INVOICE_ID,
  voidReason: 'legacy no-TIN event document — 064 remediation',
};

describe('voidInvoice — S32 non-member event rows + S31 kind-true re-render', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── 8A: pending-refund guard (void) ──────────────────────────────────────
  //
  // Voiding while a refund is settling flips the invoice to `void`, so the
  // refund's own Phase-B §86/10 then declines against it and the Stripe-settled
  // refund is stranded `pending` forever. The guard refuses (409) ABOVE the
  // first write. UNCONDITIONAL — a void has no refund-origin variant.
  it('blocks a void with refund_in_progress when a pending refund exists', async () => {
    const guard = vi.fn(async () => 1);
    const deps = makeDeps(makeIssuedMembership(), {
      pendingRefundGuard: { countPendingRefundsForInvoice: guard },
    });

    const r = await voidInvoice(deps, INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('refund_in_progress');
    // ABOVE the first write — no tx, no re-render.
    expect(deps.invoiceRepo.withTx).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledWith('test-swecham', INVOICE_ID);
  });

  it('consults the guard on a void happy path (count 0 → proceeds)', async () => {
    const deps = makeDeps(makeIssuedMembership());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    expect(deps.pendingRefundGuard.countPendingRefundsForInvoice).toHaveBeenCalledWith(
      'test-swecham',
      INVOICE_ID,
    );
  });

  it('S32 — LEGACY non-member ISSUED event row voids OK (remediation Step 2.1 executable)', async () => {
    const deps = makeDeps(makeLegacyNoTinEvent());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');
  });

  it('S32 — non-member event void audit: invoice_voided payload carries event_registration_id and NO member_id (non-timeline branch)', async () => {
    const deps = makeDeps(makeLegacyNoTinEvent());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const voidedCall = emitCalls.find((c) => c[1].eventType === 'invoice_voided');
    expect(voidedCall).toBeDefined();
    // In-tx emit (atomic with applyVoid).
    expect(voidedCall![0]).toBe(OPAQUE_TX);
    const payload = voidedCall![1].payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe('reg-uuid-1');
    // Payload parity with the membership branch (B-1 hashed reason etc.).
    expect(payload.invoice_id).toBe(INVOICE_ID);
    expect(typeof payload.void_reason_sha256).toBe('string');
    expect(payload.original_pdf_sha256).toBe('a'.repeat(64));
    expect(payload.new_pdf_sha256).toBe('b'.repeat(64));
  });

  it('S32 — MEMBERSHIP row with member_id NULL stays a data-corruption reject (no_snapshot_on_invoice)', async () => {
    const deps = makeDeps(makeIssuedMembership({ memberId: null }));
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('no_snapshot_on_invoice');
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
  });

  it('S32 — membership void regression: timeline audit branch still carries member_id', async () => {
    const deps = makeDeps(makeIssuedMembership());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const voidedCall = emitCalls.find((c) => c[1].eventType === 'invoice_voided');
    expect(voidedCall).toBeDefined();
    expect((voidedCall![1].payload as Record<string, unknown>).member_id).toBe('member-1');
  });

  it('S31 — void re-render passes voidUnderlyingKind from the persisted pdfDocKind (receipt_separate original keeps its identity)', async () => {
    const deps = makeDeps(makeLegacyNoTinEvent());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.kind).toBe('void_stamped_invoice');
    expect(renderInput.voidUnderlyingKind).toBe('receipt_separate');
  });

  it('S31 — membership void passes voidUnderlyingKind invoice', async () => {
    const deps = makeDeps(makeIssuedMembership());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.voidUnderlyingKind).toBe('invoice');
  });

  it('S31 — defensive fallback: pdfDocKind null (pre-0211 unmigrated edge) → voidUnderlyingKind invoice', async () => {
    // `invoices_non_draft_has_doc_kind` makes a null pdfDocKind on an
    // issued row unrepresentable in the DB; the `?? "invoice"` arm is
    // defensive only — pinned here so a refactor cannot drop it.
    const deps = makeDeps(makeIssuedMembership({ pdfDocKind: null }));
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.voidUnderlyingKind).toBe('invoice');
  });

  // ── bug 10: the extraction (buildVoidRenderTargets) threads the tax-critical
  // render inputs from the loaded row. The adapter goldens
  // (void-kind-true-golden / zero-rate-pdf-golden) prove those fields RENDER as
  // text; these pin that the shared helper PASSES them (a dropped WHT/zero-rate
  // line would ship silently — unit render is mocked).
  it('bug 10 — render inputs thread invoiceSubject (WHT), vatInclusive, and the §80/1(5) zero-rate spread from the loaded row', async () => {
    const deps = makeDeps(
      makeIssuedMembership({
        vatInclusive: true,
        vatTreatment: 'zero_rated_80_1_5',
        zeroRateCertNo: 'MFA-2026-000042',
        zeroRateCertDate: '2026-03-01',
      }),
    );
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.invoiceSubject).toBe('membership');
    expect(renderInput.vatInclusive).toBe(true);
    expect(renderInput.vatTreatment).toBe('zero_rated_80_1_5');
    expect(renderInput.zeroRateCertNo).toBe('MFA-2026-000042');
    expect(renderInput.zeroRateCertDate).toBe('2026-03-01');
  });

  it('bug 10 — a standard (non-zero-rate) row OMITS the zero-rate spread (deterministic-seed byte-stability)', async () => {
    const deps = makeDeps(makeIssuedMembership()); // vatTreatment: 'standard'
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    // The conditional spread must be ABSENT (undefined), never present-with-null
    // — the deterministic seed depends on the omission (SC-003).
    expect('vatTreatment' in renderInput).toBe(false);
    expect(renderInput.vatInclusive).toBe(false);
  });

  it('member prefers Thai → invoice_voided outbox row carries recipientLocale=th (email-locale audit 2026-07-16)', async () => {
    const deps = makeDeps(makeIssuedMembership());
    deps.recipientLocale.getMemberEmailLocale = vi.fn(async () => 'th' as const);
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const outboxCall = (deps.outbox.enqueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(outboxCall![1].eventType).toBe('invoice_voided');
    expect(outboxCall![1].recipientLocale).toBe('th');
  });

  // ---- 088 T068: gap 1 (legacy byte-identity regression) ----
  it('c — LEGACY §87 issued membership void: uses documentNumber, NO billMode, ONE blob (regression)', async () => {
    const deps = makeDeps(makeIssuedMembership());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderCalls = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls;
    expect(renderCalls).toHaveLength(1);
    const renderInput = renderCalls[0]![0] as PdfRenderInput;
    // The legacy §86/4 invoice keeps its §87 documentNumber + is NOT relabelled
    // as a bill (billMode absent → default ใบกำกับภาษี title preserved).
    expect(renderInput.documentNumber?.raw).toBe('SC-2026-000007');
    expect(renderInput.voidUnderlyingKind).toBe('invoice');
    expect(renderInput.billMode).toBeUndefined();
    // ONE blob synced.
    expect((deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();
  });
});

describe('voidInvoice — 088 T068 new-flow bill + paid two-blob void', () => {
  beforeEach(() => vi.clearAllMocks());

  // ---- Gap 1: unpaid new-flow ใบแจ้งหนี้ bill ----
  it('a — unpaid new-flow bill void: documentNumber NULL → bill number used, billMode + voidUnderlyingKind=invoice (ใบแจ้งหนี้), ONE blob', async () => {
    const deps = makeDeps(makeIssuedBill());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    const renderCalls = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls;
    expect(renderCalls).toHaveLength(1);
    const renderInput = renderCalls[0]![0] as PdfRenderInput;
    // The bill number rides billDocumentNumberRaw (documentNumber is NULL).
    expect(renderInput.documentNumber?.raw).toBe(BILL_NO);
    // billMode + voidUnderlyingKind='invoice' → template titles it ใบแจ้งหนี้
    // (never "Tax Invoice"); see void-kind-true-golden bill case.
    expect(renderInput.voidUnderlyingKind).toBe('invoice');
    expect(renderInput.billMode).toBe(true);
    expect(renderInput.kind).toBe('void_stamped_invoice');

    // Exactly ONE blob — no receipt to stamp.
    expect((deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();

    // Audit + outbox carry the resolved bill number (not a null documentNumber).
    const emitCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const voidedCall = emitCalls.find((c) => c[1].eventType === 'invoice_voided');
    expect(voidedCall).toBeDefined();
    const payload = voidedCall![1].payload as Record<string, unknown>;
    expect(payload.document_number).toBe(BILL_NO);
    expect(payload.new_pdf_sha256).toBe('b'.repeat(64));
    expect('new_receipt_pdf_sha256' in payload).toBe(false);
    const outboxCall = (deps.outbox.enqueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(outboxCall![1].documentNumber).toBe(BILL_NO);
  });

  // ---- Gap 2: paid membership — BOTH blobs stamped ----
  it('b — paid membership void: BOTH bill + receipt blobs re-rendered + synced, correct kinds/numbers/overlays', async () => {
    const deps = makeDeps(makePaidMembershipTwoBlob());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    // TWO renders: [0] = bill (Target A), [1] = §86/4 receipt (Target B).
    const renderCalls = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls;
    expect(renderCalls).toHaveLength(2);
    const billRender = renderCalls[0]![0] as PdfRenderInput;
    const receiptRender = renderCalls[1]![0] as PdfRenderInput;

    // Target A — the ใบแจ้งหนี้ bill: SC number, billMode, invoice underlying.
    expect(billRender.voidUnderlyingKind).toBe('invoice');
    expect(billRender.billMode).toBe(true);
    expect(billRender.documentNumber?.raw).toBe(BILL_NO);
    // Target B — the §86/4 tax receipt: RC number, receipt_combined underlying,
    // dated at the PAYMENT date (D7), NO billMode.
    expect(receiptRender.voidUnderlyingKind).toBe('receipt_combined');
    expect(receiptRender.billMode).toBeUndefined();
    expect(receiptRender.documentNumber?.raw).toBe(RC_NO);
    expect(receiptRender.issueDate).toBe('2026-05-01');

    // BOTH blobs uploaded at their own content-addressed keys, overwrite on.
    const uploadCalls = (deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mock.calls;
    expect(uploadCalls).toHaveLength(2);
    const uploadedKeys = uploadCalls.map((c) => (c[0] as { key: string }).key);
    expect(uploadedKeys).toContain(`invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`);
    expect(uploadedKeys).toContain(RECEIPT_BLOB_KEY);
    for (const c of uploadCalls) {
      expect((c[0] as { allowOverwrite?: boolean }).allowOverwrite).toBe(true);
    }

    // BOTH sha columns synced — bill via applyInvoicePdfRegeneration, receipt
    // via applyReceiptPdfRegeneration.
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).toHaveBeenCalledTimes(1);
    const invoiceRegenArg = (
      deps.invoiceRepo.applyInvoicePdfRegeneration as ReturnType<typeof vi.fn>
    ).mock.calls[0]![1] as { pdfSha256: string };
    const receiptRegenArg = (
      deps.invoiceRepo.applyReceiptPdfRegeneration as ReturnType<typeof vi.fn>
    ).mock.calls[0]![1] as { receiptPdfSha256: string };
    expect(invoiceRegenArg.pdfSha256).toBe('b'.repeat(64));
    expect(receiptRegenArg.receiptPdfSha256).toBe('c'.repeat(64));

    // Audit payload carries BOTH before/after shas.
    const voidedCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].eventType === 'invoice_voided',
    );
    const payload = voidedCall![1].payload as Record<string, unknown>;
    expect(payload.member_id).toBe('member-1');
    expect(payload.original_pdf_sha256).toBe('a'.repeat(64));
    expect(payload.new_pdf_sha256).toBe('b'.repeat(64));
    expect(payload.original_receipt_pdf_sha256).toBe(RECEIPT_ORIGINAL_SHA);
    expect(payload.new_receipt_pdf_sha256).toBe('c'.repeat(64));

    // Returned Invoice reflects BOTH freshly-synced shas.
    expect(r.value.pdf?.sha256).toBe('b'.repeat(64));
    expect(r.value.receiptPdf?.sha256).toBe('c'.repeat(64));
  });

  // ---- Gap 2: paid single-blob (event-no-TIN §105 as-paid) ----
  it('d — paid ONE-blob §105 as-paid void: stamps only its blob (receiptPdf null → no Target B)', async () => {
    const deps = makeDeps(makePaidAsPaidNoTinEvent());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    const renderCalls = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls;
    expect(renderCalls).toHaveLength(1);
    const renderInput = renderCalls[0]![0] as PdfRenderInput;
    // Single §105 receipt blob: RE number, receipt_separate underlying, no billMode.
    expect(renderInput.voidUnderlyingKind).toBe('receipt_separate');
    expect(renderInput.billMode).toBeUndefined();
    expect(renderInput.documentNumber?.raw).toBe(RE_NO);

    expect((deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();

    // Non-member event → non-timeline audit branch (no member_id).
    const voidedCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].eventType === 'invoice_voided',
    );
    const payload = voidedCall![1].payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe('reg-uuid-1');
  });

  // ---- FIX 1 (H-1): Target A void render preserves vatInclusive ----
  it('H-1 — event as-paid §105 void: Target A passes vatInclusive=true (VOID copy keeps the "VAT included" annotation)', async () => {
    // makePaidAsPaidNoTinEvent carries vatInclusive=true (event Model B). Before
    // FIX 1 Target A dropped it → the §87/3 retained VOID copy misstated a
    // VAT-inclusive doc as VAT-exclusive (SC-003 infidelity).
    const deps = makeDeps(makePaidAsPaidNoTinEvent());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.vatInclusive).toBe(true);
  });

  it('H-1 — membership void: Target A passes vatInclusive=false (explicit, not undefined)', async () => {
    const deps = makeDeps(makeIssuedBill());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    const renderInput = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as PdfRenderInput;
    expect(renderInput.vatInclusive).toBe(false);
  });

  // ---- Refusals: only issued|paid voidable ----
  it('refuses to void a credited invoice (invalid_status; no side effects)', async () => {
    const deps = makeDeps(makePaidMembershipTwoBlob({ status: 'credited' }));
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_status');
    if (r.error.code === 'invalid_status') expect(r.error.status).toBe('credited');
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyVoid).not.toHaveBeenCalled();
  });

  // ---- Error/throw paths on the NEW branches ----
  it('e1 — Target A render failure → pdf_render_failed, applyVoid NOT called (rollback)', async () => {
    const deps = makeDeps(makeIssuedBill());
    (deps.pdfRender.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom-A'),
    );
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('pdf_render_failed');
    expect(deps.invoiceRepo.applyVoid).not.toHaveBeenCalled();
  });

  it('e2 — Target B (receipt) render failure on a paid two-blob void → pdf_render_failed, applyVoid NOT called', async () => {
    const deps = makeDeps(makePaidMembershipTwoBlob());
    // First render (Target A / bill) succeeds; second (Target B / receipt) throws.
    (deps.pdfRender.render as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })
      .mockRejectedValueOnce(new Error('boom-B'));
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('pdf_render_failed');
    // Phase 1 rolled back — neither blob synced.
    expect(deps.invoiceRepo.applyVoid).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();
  });

  it('e3 — concurrent state change: applyVoid conflict → concurrent_state_change', async () => {
    const deps = makeDeps(makeIssuedBill());
    (deps.invoiceRepo.applyVoid as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new InvoiceApplyConflictError('applyVoid'),
    );
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('concurrent_state_change');
  });

  it('e4 — Phase 2 receipt-blob upload failure keeps void committed; bill sha still synced', async () => {
    const deps = makeDeps(makePaidMembershipTwoBlob());
    // Bill blob upload succeeds; receipt blob upload throws (2nd uploadPdf call).
    (deps.blob.uploadPdf as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ key: 'bill', url: 'https://blob.test/bill' })
      .mockRejectedValueOnce(new Error('receipt blob outage'));
    const r = await voidInvoice(deps, INPUT);
    // Void IS committed despite the Phase-2 receipt failure.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');
    // Bill sha synced; receipt sha sync was never reached (upload threw first).
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();
    // Return value: bill sha patched, receipt sha left at the Phase-1 value.
    expect(r.value.pdf?.sha256).toBe('b'.repeat(64));
    expect(r.value.receiptPdf?.sha256).toBe(RECEIPT_ORIGINAL_SHA);
    // A pdf_render_failed audit documents the deferred receipt overlay.
    const syncFail = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) =>
        c[1].eventType === 'pdf_render_failed' &&
        (c[1].payload as Record<string, unknown>).context ===
          'invoice_void_phase2_receipt_sync',
    );
    expect(syncFail).toBeDefined();
    const pl = syncFail![1].payload as Record<string, unknown>;
    expect(pl.phase).toBe('blob_upload');
    expect(pl.blob_bytes_uploaded).toBe(false);
  });

  // ── bug 10: Phase-2 leg-split recovery ───────────────────────────────────
  it('bug 10 M1 — blob_upload leg failure sets the reconcile marker (cron re-renders)', async () => {
    const deps = makeDeps(makeIssuedMembership());
    (deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob outage'),
    );
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    expect(deps.invoiceRepo.markVoidPdfReconcilePending).toHaveBeenCalledTimes(1);
    expect(
      (deps.invoiceRepo.markVoidPdfReconcilePending as ReturnType<typeof vi.fn>)
        .mock.calls[0]![1],
    ).toMatchObject({ tenantId: 'test-swecham', invoiceId: INVOICE_ID });
    // The blob_upload leg NEVER retries the sha-write (the blob has no stamped
    // bytes to sync a sha against).
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).not.toHaveBeenCalled();
  });

  it('bug 10 M2 — sha_sync leg failure retries the sha-write inline and sets NO marker', async () => {
    const deps = makeDeps(makeIssuedMembership());
    // Upload succeeds; the Phase-2 sha-write throws once, then the inline retry
    // (a fresh withTx) succeeds — the blob already holds the stamped bytes.
    (deps.invoiceRepo.applyInvoicePdfRegeneration as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('sha write outage'))
      .mockResolvedValueOnce(undefined);
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    // Called twice: the failed Phase-2 write + the successful inline retry.
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(2);
    // NEVER handed to the re-render cron (re-rendering would break the email's
    // sha_P1 integrity check on the already-correct blob).
    expect(deps.invoiceRepo.markVoidPdfReconcilePending).not.toHaveBeenCalled();
    // Recovered inline → NO persistent-gap audit.
    expect(
      (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1].eventType === 'pdf_render_failed',
      ),
    ).toEqual([]);
    // The recovered (stamped) sha is patched onto the return.
    if (r.ok) expect(r.value.pdf?.sha256).toBe('b'.repeat(64));
  });

  it('bug 10 M3 — full Phase-2 success sets no reconcile marker', async () => {
    const deps = makeDeps(makeIssuedMembership());
    const r = await voidInvoice(deps, INPUT);
    expect(r.ok).toBe(true);
    expect(deps.invoiceRepo.markVoidPdfReconcilePending).not.toHaveBeenCalled();
  });

  it('bug 10 M4 — a reconcile-marker write failure is swallowed (void still succeeds)', async () => {
    const deps = makeDeps(makeIssuedMembership());
    (deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob outage'),
    );
    (
      deps.invoiceRepo.markVoidPdfReconcilePending as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('marker write outage'));
    const r = await voidInvoice(deps, INPUT);
    // The public contract (Result<Invoice, VoidInvoiceError>) holds despite the
    // double-fault — the pdf_render_failed audit still preserves the signal.
    expect(r.ok).toBe(true);
  });
});

/**
 * 106-void-on-reissue Task 1 — `voidInvoice` gains three optional
 * composition-only inputs so `issueMembershipBill` (a later task) can
 * auto-void a member's prior membership bill without emailing them and
 * without ever VOID-stamping a paid §86/4:
 *   - `requireStatus: 'issued'` — tax-safety barrier; refuses anything that
 *     is not still `issued` (a paid §86/4 must go through a §86/10 credit
 *     note, never an automated void).
 *   - `suppressCancellationEmail` — skip the FR-036 outbox row on an
 *     automated supersede (the member gets the NEW bill's email instead).
 *   - `supersededByInvoiceId` — structured audit trail linking the voided
 *     row to the invoice that replaced it.
 *
 * Adaptation note: the brief's tests 3+4 pass
 * `makeDeps(loaded, { settings: { autoEmailEnabled: true } })`, but
 * `VoidInvoiceDeps` has no `settings` field (settings are read via
 * `tenantSettingsRepo.getForIssue`, not a deps override) — `makeSettings()`
 * already defaults `autoEmailEnabled: true` and `makeIssuedBill()` already
 * carries `autoEmailOnIssue: true`, so the intent ("tenant
 * auto_email_enabled=true") is met by the plain `makeDeps(loaded)` default;
 * the invalid override was dropped rather than adapted to a different shape.
 */
describe('void-on-reissue options', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requireStatus:"issued" refuses a paid bill (does not VOID-stamp a §86/4)', async () => {
    const loaded = makePaidMembershipTwoBlob(); // status: 'paid'
    const deps = makeDeps(loaded);
    const res = await voidInvoice(deps, {
      tenantId: 't1',
      actorUserId: 'admin-1',
      invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded',
      requireStatus: 'issued',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ code: 'invalid_status', status: 'paid' });
    expect(deps.pdfRender.render).not.toHaveBeenCalled(); // never re-rendered a §86/4
  });

  it('requireStatus:"issued" still voids an issued bill', async () => {
    const loaded = makeIssuedBill(); // status: 'issued', new-flow bill
    const deps = makeDeps(loaded);
    const res = await voidInvoice(deps, {
      tenantId: 't1',
      actorUserId: 'admin-1',
      invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded',
      requireStatus: 'issued',
    });
    expect(res.ok).toBe(true);
    // No supersededByInvoiceId was passed → the audit payload must omit the key
    // entirely (mirrors the presence test below for the sibling ternary-spread
    // field), not merely carry it as `undefined`.
    const voidedEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].eventType === 'invoice_voided',
    );
    const payload = voidedEmit![1].payload as Record<string, unknown>;
    expect('superseded_by_invoice_id' in payload).toBe(false);
  });

  it('suppressCancellationEmail:true enqueues NO outbox row (tenant auto_email_enabled=true)', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded);
    await voidInvoice(deps, {
      tenantId: 't1',
      actorUserId: 'admin-1',
      invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded',
      suppressCancellationEmail: true,
    });
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('manual void (no suppress flag) STILL enqueues the cancellation email (regression)', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded);
    await voidInvoice(deps, {
      tenantId: 't1',
      actorUserId: 'admin-1',
      invoiceId: loaded.invoiceId,
      voidReason: 'manual cancel',
    });
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('supersededByInvoiceId is written to the invoice_voided payload', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded);
    await voidInvoice(deps, {
      tenantId: 't1',
      actorUserId: 'admin-1',
      invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded',
      supersededByInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const voidedEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].eventType === 'invoice_voided',
    );
    expect(
      (voidedEmit?.[1].payload as Record<string, unknown> | undefined)
        ?.superseded_by_invoice_id,
    ).toBe('11111111-1111-1111-1111-111111111111');
  });
});
