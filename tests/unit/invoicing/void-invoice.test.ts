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
      lockForUpdate: vi.fn(async () => loaded?.status ?? null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(async () => {}),
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
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
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
});
