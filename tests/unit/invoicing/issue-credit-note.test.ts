/**
 * Task 8 (054-event-fee-invoices) — issueCreditNote Application-layer unit
 * coverage for NON-member (event-fee) invoices.
 *
 * Constitution Principle II: this use-case is a tax-document (§86/4 + §87)
 * surface, so every new branch introduced by the event path must be tested.
 *
 * Branches exercised here (NON-member + matched-member event paths):
 *  1. full credit on a NON-member event invoice (memberId NULL) → succeeds,
 *     `credit_note_issued` via the NON-timeline branch (payload has NO
 *     `member_id`, HAS `event_registration_id`); VAT reconciles to the STORED
 *     split (calculateCreditNoteVat uses loaded.vat/loaded.total, NOT a
 *     recompute from lines); NO `no_snapshot_on_invoice` early-return.
 *  2. partial credit on the same NON-member event invoice → succeeds via the
 *     same non-timeline branch; partial VAT split reconciles.
 *  3. email SKIPPED when the non-member buyer snapshot's
 *     primary_contact_email is empty ('') — no outbox enqueue, even though
 *     auto-email is enabled.
 *  4. matched-member event credit note (memberId NON-null) → TIMELINE branch
 *     (payload HAS `member_id`).
 *  5. regression: a NON-member event invoice that DOES have a contact email
 *     enqueues the credit-note email (proves the guard is `if (email)` not
 *     `if (memberId)`).
 *
 * Ports are mocked with vi.fn(); the tx parameter is opaque. PDF render + Blob
 * upload are stubbed (deterministic). This mirrors the issue-invoice.ts unit
 * mock-deps pattern.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { InvoiceFixtureOverrides } from '../../helpers/invoice-fixture-overrides';
import {
  asCreditNoteId,
  type CreditNote,
} from '@/modules/invoicing/domain/credit-note';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { fiscalYearFromUtcIso } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';

// ---- Fixtures ---------------------------------------------------------------

const INVOICE_ID = '00000000-0000-0000-0000-000000000001';
const EVENT_REGISTRATION_ID = '00000000-0000-0000-0000-0000000000aa';
const EVENT_ID = '00000000-0000-0000-0000-0000000000bb';
const FY = fiscalYearFromUtcIso('2026-04-18T10:00:00Z', 1);

const TENANT_SNAP: TenantIdentitySnapshot = Object.freeze({
  legal_name_th: 'หอการค้าไทย-สวีเดน',
  legal_name_en: 'Thai-Swedish Chamber of Commerce',
  tax_id: '0000000000000',
  address_th: 'กรุงเทพฯ',
  address_en: 'Bangkok',
  logo_blob_key: null,
});

/** Non-member buyer snapshot WITH a contact email (the normal event case). */
const BUYER_SNAP_WITH_EMAIL: MemberIdentitySnapshot = Object.freeze({
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
  member_number: null,
  member_number_display: null,
});

/**
 * Non-member buyer snapshot with an EMPTY contact email but a 13-digit TIN.
 * The TIN means `issueInvoice` resolved kind='invoice' (§86/4 tax invoice),
 * so the §86/10 `receipt_not_creditable` guard does NOT fire — this fixture
 * isolates the empty-email auto-email-skip branch from the receipt_separate
 * block. (A no-TIN event buyer would be a §105 receipt_separate and is covered
 * by BUYER_SNAP_NO_TIN below.)
 */
const BUYER_SNAP_NO_EMAIL: MemberIdentitySnapshot = Object.freeze({
  legal_name: 'Corp Without Email Co., Ltd.',
  tax_id: '1112223334445',
  address: '99 Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Procurement Desk',
  primary_contact_email: '',
  member_number: null,
  member_number_display: null,
});

/**
 * Non-member buyer snapshot WITHOUT a TIN (walk-in guest). `issueInvoice`
 * resolves this to kind='receipt_separate' (§105 ใบเสร็จรับเงิน). A §86/10
 * credit note cannot reference a §105 receipt → issueCreditNote must reject it
 * with `receipt_not_creditable` (final-review HIGH 1).
 */
const BUYER_SNAP_NO_TIN: MemberIdentitySnapshot = Object.freeze({
  legal_name: 'Walk-in Guest',
  tax_id: null,
  address: '99 Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Walk-in Guest',
  primary_contact_email: 'walkin@example.com',
  member_number: null,
  member_number_display: null,
});

/**
 * Issued EVENT invoice factory. Defaults to a NON-member event invoice
 * (memberId NULL) with a pinned buyer snapshot + the Task-7 stored VAT split.
 * 25,000 satang (250 THB) inclusive @ 7% → subtotal 23364, vat 1636.
 */
function makeIssuedEventInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
  const eventLine: InvoiceLine = {
    lineId: asInvoiceLineId('line-evt-1'),
    kind: 'event_fee',
    descriptionTh: 'ค่าเข้าร่วมงาน',
    descriptionEn: 'Event fee',
    unitPrice: Money.fromSatangUnsafe(25_000n),
    quantity: '1.0000',
    proRateFactor: null,
    total: Money.fromSatangUnsafe(25_000n),
    position: 1,
  };

  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: null, // NON-member event invoice
    planId: null,
    planYear: null,
    invoiceSubject: 'event',
    vatInclusive: true,
    eventId: EVENT_ID,
    eventRegistrationId: EVENT_REGISTRATION_ID,
    status: 'paid',
    draftByUserId: 'actor-user',
    fiscalYear: FY,
    sequenceNumber: 7,
    documentNumber: DocumentNumber.of('EVT', FY, 7).ok
      ? (DocumentNumber.of('EVT', FY, 7) as { ok: true; value: DocumentNumber }).value
      : (undefined as never),
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: '2026-04-19T00:00:00Z',
    voidedAt: null,
    currency: 'THB',
    // Task-7 stored split (Model B): subtotal+vat===total exactly.
    subtotal: Money.fromSatangUnsafe(23_364n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(1_636n),
    total: Money.fromSatangUnsafe(25_000n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: TENANT_SNAP,
    memberIdentitySnapshot: BUYER_SNAP_WITH_EMAIL,
    paymentMethod: 'bank_transfer',
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: 'actor-user',
    paymentDate: '2026-04-19',
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: 'invoicing/test-swecham/2026/inv.pdf',
      sha256: Sha256Hex.ofUnsafe('c'.repeat(64)),
      templateVersion: 1,
    },
    // 064 Task 12 — what the main PDF IS (migration 0211). The factory default
    // models a bill-first TIN event invoice, whose issue-time render was a
    // §86/4 ใบกำกับภาษี ('invoice'). As-paid fixtures override this to
    // 'receipt_combined' / 'receipt_separate'.
    pdfDocKind: 'invoice',
    // 088 US6 — the factory default now models a Shape-1 paid parent (bill-first
    // TIN event): the §86/4 tax receipt is a SEPARATE rendered blob, so the
    // CREDITED annotation re-targets it (kind='receipt_combined') and
    // receiptPdfStatus='rendered' gates creditability. receiptDocumentNumberRaw
    // stays null → the receipt reuses the invoice-stream documentNumber
    // (combined-reuse) as its RC number. As-paid Shape-2 fixtures override
    // receiptPdf:null + pdfDocKind:'receipt_combined'.
    receiptPdf: {
      blobKey: 'invoicing/test-swecham/2026/inv_receipt.pdf',
      sha256: Sha256Hex.ofUnsafe('f'.repeat(64)),
      templateVersion: 1,
    },
    receiptPdfStatus: 'rendered',
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [eventLine],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
    // 054-event-fee-invoices — assert at the factory boundary: the flat
    // `...overrides` spread over a discriminated-union `Invoice` cannot be
    // re-narrowed to a concrete arm by inference. The LOW-12 corrupted-row
    // test deliberately passes `eventRegistrationId: null` (a CHECK-violating
    // shape) through this factory to exercise the runtime guard.
  } as Invoice;
}

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 0n as never,
    invoiceNumberPrefix: 'EVT',
    creditNoteNumberPrefix: 'EVTC',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    identity: TENANT_SNAP,
    ...overrides,
  } as TenantInvoiceSettingsView;
}

/**
 * Build a CreditNote object for the repo's insert/find stubs. The exact money
 * values don't matter for the audit-branch assertions; we echo the proposed
 * amounts so the returned aggregate is internally consistent.
 */
function makeCreditNote(
  creditAmount: Money,
  vat: Money,
  total: Money,
  // 054-event-fee-invoices (Task 8 reviewer fix) — null for non-member
  // event CNs, a real uuid for matched-member CNs. Was `string` + `?? 'unknown'`,
  // which was a lie that could make a future ownership-check test pass for the
  // wrong reason. Now honest: non-member invoice → null, matched-member → memberId.
  originalInvoiceMemberId: string | null,
): CreditNote {
  return {
    tenantId: 'test-swecham',
    creditNoteId: asCreditNoteId('00000000-0000-0000-0000-0000000000c1'),
    originalInvoiceId: asInvoiceId(INVOICE_ID),
    originalInvoiceMemberId,
    fiscalYear: FY,
    sequenceNumber: 1,
    documentNumber: (DocumentNumber.of('EVTC', FY, 1) as { ok: true; value: DocumentNumber }).value,
    issueDate: '2026-04-20',
    issuedByUserId: 'actor-user',
    reason: 'event cancelled',
    creditAmount,
    vat,
    total,
    tenantIdentitySnapshot: TENANT_SNAP,
    memberIdentitySnapshot: BUYER_SNAP_WITH_EMAIL,
    pdf: {
      blobKey: 'invoicing/test-swecham/2026/cn.pdf',
      sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
      templateVersion: 1,
    },
    sourceRefundId: null,
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
  };
}

function makeDeps(
  invoice: Invoice | null,
  settings: TenantInvoiceSettingsView | null,
  overrides: Partial<IssueCreditNoteDeps> = {},
): IssueCreditNoteDeps {
  const opaqueTx = Symbol('tx');
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
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => (invoice?.status ?? null) as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(async () => {}),
      applyInvoicePdfRegeneration: vi.fn(async () => {}),
      // 088 US6 — Shape-1 receipt re-annotation persists via this method.
      applyReceiptPdfRegeneration: vi.fn(async () => {}),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
    } as unknown as IssueCreditNoteDeps['invoiceRepo'],
    creditNoteRepo: {
      insertCreditNote: vi.fn(async (_tx, input) =>
        makeCreditNote(
          Money.fromSatangUnsafe(input.creditAmountSatang),
          Money.fromSatangUnsafe(input.vatSatang),
          Money.fromSatangUnsafe(input.totalSatang),
          (invoice?.memberId ?? null),
        ),
      ),
      findById: vi.fn(),
      findByOriginalInvoice: vi.fn(),
      // M1 — default: no sibling CN exists for the refund yet, so a
      // `sourceRefundId`-carrying call proceeds to insert (the F5-real-refund
      // derivation path). Refund-race / idempotency tests override this.
      findBySourceRefundId: vi.fn(async () => null),
      // Return the just-inserted CN for the AS4 annotation re-render.
      findByOriginalInvoiceInTx: vi.fn(async () => [
        makeCreditNote(
          Money.fromSatangUnsafe(1n),
          Money.fromSatangUnsafe(0n),
          Money.fromSatangUnsafe(1n),
          invoice?.memberId ?? null,
        ),
      ]),
      listPaged: vi.fn(),
    } as unknown as IssueCreditNoteDeps['creditNoteRepo'],
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    } as unknown as IssueCreditNoteDeps['tenantSettingsRepo'],
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('e'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as IssueCreditNoteDeps['blob'],
    audit: {
      emit: vi.fn(async () => {}),
    },
    clock: {
      nowIso: () => '2026-04-20T10:00:00Z',
    },
    outbox: {
      enqueue: vi.fn(async () => {}),
    },
    // Email-locale audit 2026-07-16 — default no stored preference (→ 'en').
    recipientLocale: {
      getMemberEmailLocale: vi.fn(async () => null),
    },
    currentTemplateVersion: 1,
    // 8A — default: no refund in flight → the guard never fires on the existing
    // happy paths. Guard tests override with a positive count.
    pendingRefundGuard: {
      countPendingRefundsForInvoice: vi.fn(async () => 0),
    },
    ...overrides,
  };
}

// ---- Tests ------------------------------------------------------------------

describe('issueCreditNote — event-fee (non-member + matched-member) Task 8', () => {
  const baseInput = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    requestId: 'req-cn-1',
    invoiceId: INVOICE_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 8A: pending-refund guard (manual credit note) ────────────────────────
  //
  // A manual §86/10 issued while a refund is settling consumes the creditable
  // remainder the refund's own credit note needs, stranding that Stripe-settled
  // refund `pending` forever. The guard refuses (409) ABOVE the first write and
  // is SKIPPED for a refund-origin CN (which IS that refund's own §86/10).
  it('blocks a MANUAL credit note with refund_in_progress when a pending refund exists', async () => {
    const invoice = makeIssuedEventInvoice();
    const guard = vi.fn(async () => 1);
    const deps = makeDeps(invoice, makeSettings(), {
      pendingRefundGuard: { countPendingRefundsForInvoice: guard },
    });

    const r = await issueCreditNote(deps, {
      ...baseInput,
      creditTotalSatang: 25_000n,
      reason: 'manual credit while a refund is in flight',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('refund_in_progress');
    // ABOVE the first write — no tx, no §87 number, no render, no insert.
    expect(deps.invoiceRepo.withTx).not.toHaveBeenCalled();
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledWith('test-swecham', INVOICE_ID);
  });

  it('does NOT block a refund-origin credit note (sourceRefundId set), never consulting the guard', async () => {
    const invoice = makeIssuedEventInvoice();
    const sameCn: CreditNote = {
      ...makeCreditNote(
        Money.fromSatangUnsafe(1_000n),
        Money.fromSatangUnsafe(70n),
        Money.fromSatangUnsafe(1_070n),
        null,
      ),
      originalInvoiceId: asInvoiceId(INVOICE_ID),
      sourceRefundId: 'rfnd-match',
    };
    const guard = vi.fn(async () => 1); // would block IF consulted
    const deps = makeDeps(invoice, makeSettings(), {
      creditNoteRepo: {
        insertCreditNote: vi.fn(),
        findById: vi.fn(),
        findByOriginalInvoice: vi.fn(),
        findByOriginalInvoiceInTx: vi.fn(async () => []),
        listPaged: vi.fn(),
        findBySourceRefundId: vi.fn(async () => sameCn),
      } as unknown as IssueCreditNoteDeps['creditNoteRepo'],
      pendingRefundGuard: { countPendingRefundsForInvoice: guard },
    });

    const r = await issueCreditNote(deps, {
      ...baseInput,
      creditTotalSatang: 1_000n,
      reason: "the refund's own §86/10",
      sourceRefundId: 'rfnd-match',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    // The gate is `sourceRefundId === undefined` — a refund-origin CN skips it.
    expect(guard).not.toHaveBeenCalled();
  });

  it('consults the guard on a manual-CN happy path (count 0 → proceeds)', async () => {
    const invoice = makeIssuedEventInvoice();
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      creditTotalSatang: 25_000n,
      reason: 'manual credit, no refund pending',
    });

    expect(r.ok).toBe(true);
    expect(deps.pendingRefundGuard.countPendingRefundsForInvoice).toHaveBeenCalledWith(
      'test-swecham',
      INVOICE_ID,
    );
  });

  it('full credit on NON-member event invoice → succeeds, NON-timeline audit (no member_id, has event_registration_id), VAT reconciles to stored split', async () => {
    const invoice = makeIssuedEventInvoice(); // memberId null, total 25000, vat 1636
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      creditTotalSatang: 25_000n, // full
      reason: 'event cancelled',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    // Audit: the credit_note_issued emit must carry NO member_id and HAVE
    // event_registration_id (non-timeline branch).
    const cnEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, ev]) => ev.eventType === 'credit_note_issued',
    );
    expect(cnEmit, 'credit_note_issued emit fired').toBeDefined();
    const payload = cnEmit![1].payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(EVENT_REGISTRATION_ID);
    expect(payload.credit_note_id).toBeDefined();

    // VAT reconciles to the STORED split (full credit → vat 1636 of 25000).
    const insertCall = (deps.creditNoteRepo.insertCreditNote as ReturnType<typeof vi.fn>).mock
      .calls[0]![1];
    expect(insertCall.totalSatang).toBe(25_000n);
    expect(insertCall.vatSatang).toBe(1_636n);
    expect(insertCall.creditAmountSatang + insertCall.vatSatang).toBe(insertCall.totalSatang);
  });

  it('partial credit on NON-member event invoice → succeeds, non-timeline branch, partial VAT reconciles', async () => {
    const invoice = makeIssuedEventInvoice();
    const deps = makeDeps(invoice, makeSettings());

    // Credit half the gross (12,500 satang). calculateCreditNoteVat uses the
    // STORED vat/total proportionally: vat = round(creditTotal*originalVat/originalTotal).
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-partial',
      creditTotalSatang: 12_500n,
      reason: 'partial refund',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const cnEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, ev]) => ev.eventType === 'credit_note_issued',
    );
    expect(cnEmit).toBeDefined();
    expect('member_id' in (cnEmit![1].payload as Record<string, unknown>)).toBe(false);

    const insertCall = (deps.creditNoteRepo.insertCreditNote as ReturnType<typeof vi.fn>).mock
      .calls[0]![1];
    // total credited = 12500; vat+credit must equal it (exact split invariant).
    expect(insertCall.creditAmountSatang + insertCall.vatSatang).toBe(insertCall.totalSatang);
    expect(insertCall.totalSatang).toBe(12_500n);
  });

  it('email SKIPPED when non-member buyer snapshot email is empty (no outbox enqueue despite auto-email on)', async () => {
    const invoice = makeIssuedEventInvoice({ memberIdentitySnapshot: BUYER_SNAP_NO_EMAIL });
    const deps = makeDeps(invoice, makeSettings({ autoEmailEnabled: true }));

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-noemail',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    // Auto-email is enabled but the recipient email is empty → no enqueue.
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    // MEDIUM-5 — the success result must SIGNAL the skip so the admin gets
    // non-blocking feedback ("buyer has no email on file") instead of silence.
    if (!r.ok) throw new Error('cn failed');
    expect(r.value.emailDelivery).toBe('skipped_no_recipient');
  });

  it('email ENQUEUED for a non-member event invoice WITH a contact email (guard is on email, not memberId)', async () => {
    const invoice = makeIssuedEventInvoice(); // BUYER_SNAP_WITH_EMAIL
    const deps = makeDeps(invoice, makeSettings({ autoEmailEnabled: true }));

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-withemail',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'credit_note_issued',
        recipientEmail: 'jane@beta.example',
      }),
    );
    // MEDIUM-5 — the email WAS enqueued, so the signal reports 'sent'.
    if (!r.ok) throw new Error('cn failed');
    expect(r.value.emailDelivery).toBe('sent');
  });

  it('matched member prefers Thai → credit_note_issued outbox row carries recipientLocale=th (email-locale audit 2026-07-16)', async () => {
    const invoice = makeIssuedEventInvoice({
      memberId: 'member-1',
      // Matched member must be a VAT registrant for the §86/10 creditability gate.
      memberIdentitySnapshot: Object.freeze({
        ...BUYER_SNAP_WITH_EMAIL,
        buyer_is_vat_registrant: true,
      }),
    });
    const deps = makeDeps(invoice, makeSettings({ autoEmailEnabled: true }));
    deps.recipientLocale.getMemberEmailLocale = vi.fn(async () => 'th' as const);
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-locale',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });
    expect(r.ok).toBe(true);
    expect(deps.recipientLocale.getMemberEmailLocale).toHaveBeenCalledWith(
      expect.anything(),
      'test-swecham',
      'member-1',
    );
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'credit_note_issued', recipientLocale: 'th' }),
    );
  });

  it('email NOT requested (auto-email disabled) → emailDelivery=not_requested, no enqueue', async () => {
    // Buyer HAS an email, but the per-invoice + tenant auto-email toggles are
    // BOTH off, so the document is intentionally NOT auto-emailed. The signal
    // must distinguish this deliberate non-send from an empty-recipient skip
    // (the UI shows NO notice for not_requested — nothing went wrong).
    const invoice = makeIssuedEventInvoice({ autoEmailOnIssue: false });
    const deps = makeDeps(invoice, makeSettings({ autoEmailEnabled: false }));

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-noautoemail',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    if (!r.ok) throw new Error('cn failed');
    expect(r.value.emailDelivery).toBe('not_requested');
  });

  it('matched-member event credit note → TIMELINE audit branch (payload HAS member_id)', async () => {
    const invoice = makeIssuedEventInvoice({
      memberId: 'member-77',
      // 059 / PR-A Task 6a — this is a MATCHED MEMBER (memberId non-null), so the
      // §86/10 creditability gate reads the RECORDED registrant flag, not the
      // TIN's presence. Only a §86/4 ใบกำกับภาษี is creditable, and a member only
      // receives one if they are a VAT registrant — so say so. (The base fixture
      // is the walk-in snapshot, where TIN-presence still decides; reusing it for
      // a matched member is what made the old TIN-keyed gate look sufficient.)
      memberIdentitySnapshot: Object.freeze({
        ...BUYER_SNAP_WITH_EMAIL,
        buyer_is_vat_registrant: true,
      }),
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-matched',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    const cnEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, ev]) => ev.eventType === 'credit_note_issued',
    );
    expect(cnEmit).toBeDefined();
    const payload = cnEmit![1].payload as Record<string, unknown>;
    expect(payload.member_id).toBe('member-77');
  });

  it('does NOT return no_snapshot_on_invoice for a NON-member event invoice (the removed bug guard)', async () => {
    const invoice = makeIssuedEventInvoice(); // memberId null but full snapshot present
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-bugcheck',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    // The OLD bug returned no_snapshot_on_invoice on memberId===null.
    expect(r.ok).toBe(true);
    if (!r.ok) expect(r.error.code).not.toBe('no_snapshot_on_invoice');
  });

  // ---- LOW-12 corrupted-event-invoice guard -------------------------------

  it('REJECTS a corrupted event invoice (subject=event, event_registration_id=null) with invalid_event_invoice BEFORE any side effect', async () => {
    // A row that violates `invoices_subject_fields_ck` (event subject but no
    // event_registration_id). The audit payload would otherwise emit a null
    // into a field the contract types as a string — guard rejects it up-front.
    const invoice = makeIssuedEventInvoice({ eventRegistrationId: null });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-corrupt-evt',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalid_event_invoice, got ok');
    expect(r.error.code).toBe('invalid_event_invoice');
    // No §87 number burned, no render, no insert, no rollup, no email.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyCreditNoteRollup).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  // ---- §86/10 doc-type gate (final-review HIGH 1) -------------------------

  it('BLOCKS a §105 receipt_separate (no-TIN event invoice) with receipt_not_creditable', async () => {
    // No-TIN event buyer → issued as receipt_separate (§105 ใบเสร็จรับเงิน).
    const invoice = makeIssuedEventInvoice({ memberIdentitySnapshot: BUYER_SNAP_NO_TIN });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-receipt-block',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_creditable, got ok');
    expect(r.error.code).toBe('receipt_not_creditable');
  });

  it('the receipt_not_creditable guard fires BEFORE allocateNext + PDF render + CN insert (no §87 number burned, no render, no rollup)', async () => {
    const invoice = makeIssuedEventInvoice({ memberIdentitySnapshot: BUYER_SNAP_NO_TIN });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-receipt-order',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(false);
    // Guard runs before the POST-SEQUENCE zone — no side effects whatsoever.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyCreditNoteRollup).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('treats a WHITESPACE-only TIN as no-TIN (trim) → receipt_separate is still blocked', async () => {
    // Mirrors the issue-invoice / record-payment `.trim() !== ''` gate so the
    // three sites stay in lockstep: a snapshot persisting '   ' must NOT be
    // treated as a valid TIN.
    const invoice = makeIssuedEventInvoice({
      memberIdentitySnapshot: { ...BUYER_SNAP_NO_TIN, tax_id: '   ' },
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-receipt-ws',
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_creditable, got ok');
    expect(r.error.code).toBe('receipt_not_creditable');
  });

  it('064 Task 10 — BLOCKS a β receipt-STREAM row (documentNumber NULL + receipt raw set) with receipt_not_creditable, NOT no_snapshot_on_invoice', async () => {
    // An as-paid no-TIN event invoice (issueEventInvoiceAsPaid β path) is a
    // LEGAL paid row whose invoice-stream pair is genuinely NULL — its number
    // lives in receipt_document_number_raw (migration 0212). The §86/10 gate
    // must fire BEFORE the snapshot-completeness guard, otherwise the legal β
    // shape is misclassified as a corrupted row (`!loaded.documentNumber` →
    // no_snapshot_on_invoice) and the operator gets the wrong error.
    const invoice = makeIssuedEventInvoice({
      memberIdentitySnapshot: BUYER_SNAP_NO_TIN,
      sequenceNumber: null,
      documentNumber: null,
      receiptDocumentNumberRaw: 'RC-2026-000007',
      pdfDocKind: 'receipt_separate',
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      tenantId: 'test-swecham',
      actorUserId: 'actor-user',
      invoiceId: INVOICE_ID,
      creditTotalSatang: 25_000n,
      reason: 'event cancelled',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_creditable, got ok');
    expect(r.error.code).toBe('receipt_not_creditable');
    // No §87 CN number burned, no render — same pre-allocation discipline.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
  });

  it('does NOT block a MEMBERSHIP invoice with no TIN (subject gate — the guard is event-only)', async () => {
    // 066 relax — a no-TIN membership invoice is now a legitimate, reachable
    // row (a valid §86/4 with name+address). A §86/10 ใบลดหนี้ against it is
    // LEGAL (it credits a real tax invoice), so the credit-note guard — scoped
    // to invoiceSubject==='event' (where no-TIN → §105 receipt, which cannot be
    // credited) — MUST NOT fire on membership. We assert the guard is bypassed
    // by observing the flow proceeds past it to allocateNext.
    const invoice = makeIssuedEventInvoice({
      invoiceSubject: 'membership',
      memberId: 'member-99',
      planId: 'plan-x',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
      memberIdentitySnapshot: { ...BUYER_SNAP_NO_TIN, tax_id: null },
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-membership-notin',
      creditTotalSatang: 25_000n,
      reason: 'membership refund',
      // F-2 (2026-07-08) — this is a FULL credit on a membership invoice, so
      // `membershipEffect` is now REQUIRED (unrelated to the no-TIN gate this
      // test targets). 'keep' preserves the original "flow proceeds" intent.
      membershipEffect: 'keep',
    });

    // The membership invoice is NOT receipt_separate → guard skipped → flow
    // proceeds (succeeds end-to-end through the mocked happy path).
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalled();
  });
});

// ---- F-2 (2026-07-08) — credit-note membership-effect intent capture -------
//
// A FULL credit on a `invoiceSubject==='membership'` invoice means the parent
// invoice's `credited_total` reaches its `total` after this credit note. The
// issuing staff member's intent ('keep' the membership vs 'cancel_membership')
// is NOT inferable — TSCC has no established mid-term-refund practice — so the
// use-case REQUIRES the caller to declare it via the new optional
// `membershipEffect` field. Partial credits and event invoices never ask (the
// field is silently ignored there — Result stays `ok`,
// `membershipCancellationRequested` is always `false`). A missing field on a
// full membership credit is the new typed error `membership_effect_required`,
// returned BEFORE `allocateNext` — same pre-allocation discipline as every
// other guard in this file (no §87 sequence number burned on a rejected
// attempt). The use-case itself never touches F8 (Principle III — F4 never
// imports F8); `membershipCancellationRequested` on the ok-value is how the
// ROUTE (presentation) knows to orchestrate the F8 cascade after commit.
describe('issueCreditNote — F-2 membership-effect intent capture', () => {
  /** Membership invoice factory — mirrors the "no TIN" test's override shape. */
  function makeMembershipInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
    return makeIssuedEventInvoice({
      invoiceSubject: 'membership',
      memberId: 'member-f2',
      planId: 'plan-f2',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
      ...overrides,
    });
  }

  const baseInput = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    invoiceId: INVOICE_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('membership + FULL credit + membershipEffect MISSING → membership_effect_required, no §87 number burned', async () => {
    const invoice = makeMembershipInvoice(); // total 25,000n, creditedTotal 0
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-missing',
      creditTotalSatang: 25_000n, // full
      reason: 'membership refund',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected membership_effect_required, got ok');
    expect(r.error.code).toBe('membership_effect_required');
    // Pre-allocation guard — no side effects whatsoever.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyCreditNoteRollup).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('membership + FULL credit (on remainder after partial) + membershipEffect MISSING → membership_effect_required', async () => {
    // Regression: if creditedTotal is already > 0 and a second credit note
    // exactly completes the remainder, that is STILL a full-credit scenario
    // that REQUIRES the membershipEffect intent, even though the _first_
    // credit note might have been partial.
    const partiallyCredited = makeMembershipInvoice({
      creditedTotal: Money.fromSatangUnsafe(12_500n), // half already credited
    });
    const deps = makeDeps(partiallyCredited, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-remainder-no-effect',
      creditTotalSatang: 12_500n, // exactly the remainder → full credit
      reason: 'complete membership refund',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected membership_effect_required, got ok');
    expect(r.error.code).toBe('membership_effect_required');
    // Pre-allocation guard — no side effects.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyCreditNoteRollup).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('membership + FULL credit + membershipEffect="keep" → succeeds, membershipCancellationRequested=false', async () => {
    const invoice = makeMembershipInvoice();
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-keep',
      creditTotalSatang: 25_000n,
      reason: 'membership refund — paperwork correction',
      membershipEffect: 'keep',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.membershipCancellationRequested).toBe(false);
  });

  it('membership + FULL credit + membershipEffect="cancel_membership" → succeeds, membershipCancellationRequested=true', async () => {
    const invoice = makeMembershipInvoice();
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-cancel',
      creditTotalSatang: 25_000n,
      reason: 'membership refund + withdrawal',
      membershipEffect: 'cancel_membership',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.membershipCancellationRequested).toBe(true);
  });

  it('membership + PARTIAL credit → membershipEffect is IGNORED (never required; a passed cancel_membership does NOT request cancellation)', async () => {
    const invoice = makeMembershipInvoice(); // total 25,000n
    const deps = makeDeps(invoice, makeSettings());

    const rMissing = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-partial-missing',
      creditTotalSatang: 12_500n, // partial — remainder stays > 0
      reason: 'partial refund',
    });
    expect(rMissing.ok, rMissing.ok ? 'ok' : `err: ${JSON.stringify(rMissing)}`).toBe(true);
    if (!rMissing.ok) throw new Error('unreachable');
    expect(rMissing.value.membershipCancellationRequested).toBe(false);

    vi.clearAllMocks();
    const invoice2 = makeMembershipInvoice();
    const deps2 = makeDeps(invoice2, makeSettings());
    const rCancel = await issueCreditNote(deps2, {
      ...baseInput,
      requestId: 'req-f2-partial-cancel-ignored',
      creditTotalSatang: 12_500n, // partial
      reason: 'partial refund',
      membershipEffect: 'cancel_membership',
    });
    expect(rCancel.ok, rCancel.ok ? 'ok' : `err: ${JSON.stringify(rCancel)}`).toBe(true);
    if (!rCancel.ok) throw new Error('unreachable');
    expect(rCancel.value.membershipCancellationRequested).toBe(false);
  });

  it('event invoice + FULL credit → membershipEffect never required, membershipCancellationRequested always false', async () => {
    const invoice = makeIssuedEventInvoice(); // invoiceSubject 'event', total 25,000n
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-f2-event',
      creditTotalSatang: 25_000n, // full
      reason: 'event cancelled',
      // deliberately omit membershipEffect — must NOT be required for events
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.membershipCancellationRequested).toBe(false);
  });
});

// ---- M1 (plan-change-ux, Option 1b) — retains_coverage derivation -----------
// The use case derives `credit_notes.retains_coverage` and threads it to the
// repo insert. The formula CHECKS `sourceRefundId` FIRST: an F5 refund-origin CN
// hard-codes `membershipEffect: 'keep'` at issue-credit-note-from-refund.ts while
// genuinely RETURNING money, so `membershipEffect === 'keep'` alone is NOT the
// retention signal. TRUE only for an F4-manual (no sourceRefundId) FULL
// membership credit with `membershipEffect: 'keep'` (paperwork correction, member
// NOT refunded → coverage retained). FALSE for F5 refunds, cancel_membership,
// partial credits, and event credits.
describe('issueCreditNote — M1 retains_coverage derivation (Option 1b)', () => {
  function makeMembershipInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
    return makeIssuedEventInvoice({
      invoiceSubject: 'membership',
      memberId: 'member-m1',
      planId: 'plan-m1',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
      ...overrides,
    });
  }

  const baseInput = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    invoiceId: INVOICE_ID,
  };

  /** Reads the `retainsCoverage` arg of the single insertCreditNote call. */
  function insertedRetainsCoverage(deps: IssueCreditNoteDeps): boolean {
    const mock = deps.creditNoteRepo.insertCreditNote as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    return mock.mock.calls[0]![1].retainsCoverage as boolean;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('membership + FULL credit + membershipEffect="keep" + NO sourceRefundId (F4-manual) → retains_coverage TRUE', async () => {
    const invoice = makeMembershipInvoice(); // total 25,000n, creditedTotal 0
    const deps = makeDeps(invoice, makeSettings());
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-m1-keep',
      creditTotalSatang: 25_000n, // full
      reason: 'membership refund — paperwork correction, member not refunded',
      membershipEffect: 'keep',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(insertedRetainsCoverage(deps)).toBe(true);
  });

  it('membership + FULL credit + membershipEffect="keep" + sourceRefundId SET (F5 real refund) → retains_coverage FALSE (sourceRefundId-first)', async () => {
    const invoice = makeMembershipInvoice();
    const deps = makeDeps(invoice, makeSettings());
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-m1-refund',
      creditTotalSatang: 25_000n, // full
      reason: 'stripe refund',
      membershipEffect: 'keep', // F5 bridge hard-codes this while returning money
      sourceRefundId: 'rfnd-m1',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(insertedRetainsCoverage(deps)).toBe(false);
  });

  it('membership + FULL credit + membershipEffect="cancel_membership" (withdrawal) → retains_coverage FALSE', async () => {
    const invoice = makeMembershipInvoice();
    const deps = makeDeps(invoice, makeSettings());
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-m1-cancel',
      creditTotalSatang: 25_000n, // full
      reason: 'membership refund + withdrawal',
      membershipEffect: 'cancel_membership',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(insertedRetainsCoverage(deps)).toBe(false);
  });

  it('membership + PARTIAL credit → retains_coverage FALSE (never a completing full-membership retention note)', async () => {
    const invoice = makeMembershipInvoice(); // total 25,000n
    const deps = makeDeps(invoice, makeSettings());
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-m1-partial',
      creditTotalSatang: 12_500n, // partial — remainder stays > 0
      reason: 'partial refund',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(insertedRetainsCoverage(deps)).toBe(false);
  });

  it('event invoice + FULL credit → retains_coverage FALSE (never consulted for event coverage)', async () => {
    const invoice = makeIssuedEventInvoice(); // invoiceSubject 'event', total 25,000n
    const deps = makeDeps(invoice, makeSettings());
    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-m1-event',
      creditTotalSatang: 25_000n, // full
      reason: 'event cancelled',
    });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(insertedRetainsCoverage(deps)).toBe(false);
  });
});

// ---- 088 US6 — CREDITED annotation re-targets the §86/4 TAX RECEIPT ----------
//
// The §86/10 ใบลดหนี้ adjusts the tax RECEIPT (the document carrying the input
// VAT), NOT the now-non-tax ใบแจ้งหนี้ bill. Two parent shapes carry the receipt:
//
//   Shape 1 — record-payment path (membership, bill-first TIN event): the
//     receipt is a SEPARATE rendered blob (`receiptPdf` non-null); the main
//     `pdf` is the bill. The annotation re-renders `receiptPdf.blobKey`
//     (kind='receipt_combined') + persists via `applyReceiptPdfRegeneration`.
//   Shape 2 — as-paid path (issueEventInvoiceAsPaid TIN event): the receipt IS
//     the main `pdf` blob (`pdfDocKind='receipt_combined'`, `receiptPdf` null).
//     The annotation re-renders `pdf.blobKey` + persists via
//     `applyInvoicePdfRegeneration` (preserves 064 Task 12 behaviour — the main
//     blob IS the §105ทวิ receipt evidence, never re-titled).
//
// A rendered §86/4 receipt is a PRECONDITION (`receiptPdfStatus==='rendered'`);
// crediting an un-materialised receipt (async 'pending'/'failed') is blocked
// with `receipt_not_rendered` before any §87 CN number is burned.
describe('issueCreditNote — US6 credited annotation re-targets the tax receipt', () => {
  const baseInput = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    invoiceId: INVOICE_ID,
    creditTotalSatang: 12_500n, // partial → the J2 annotation re-render runs
    reason: 'partial refund',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The J2 annotation render call — the one render that is NOT the CN PDF. */
  function annotationRenderInput(deps: IssueCreditNoteDeps): PdfRenderInput {
    const annotation = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as PdfRenderInput)
      .find((c) => c.kind !== 'credit_note');
    expect(annotation, 'expected a J2 annotation re-render call').toBeDefined();
    return annotation!;
  }

  /** The blob key the J2 annotation re-render uploaded to (allowOverwrite=true). */
  function annotationUploadKey(deps: IssueCreditNoteDeps): string | undefined {
    const call = (deps.blob.uploadPdf as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { key: string; allowOverwrite?: boolean })
      .find((c) => c.allowOverwrite === true);
    return call?.key;
  }

  it('Shape 1 — bill-first TIN event (separate receiptPdf) → annotation kind=receipt_combined, targets the RECEIPT blob via applyReceiptPdfRegeneration', async () => {
    const invoice = makeIssuedEventInvoice(); // factory default = Shape 1
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-shape1' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const annotation = annotationRenderInput(deps);
    expect(annotation.kind).toBe('receipt_combined');
    expect(annotation.creditedAnnotation).toBeTruthy();
    // Re-render targets the SEPARATE receipt blob, not the bill (loaded.pdf).
    expect(annotationUploadKey(deps)).toBe(invoice.receiptPdf!.blobKey);
    // Persist via the receipt-sha path, NEVER the invoice-sha path.
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).not.toHaveBeenCalled();
  });

  it('Shape 2 — as-paid TIN event (pdf_doc_kind=receipt_combined, receiptPdf null) → annotation kind=receipt_combined, targets the MAIN pdf blob via applyInvoicePdfRegeneration', async () => {
    const invoice = makeIssuedEventInvoice({
      pdfDocKind: 'receipt_combined',
      receiptPdf: null, // as-paid: the receipt IS the main pdf blob
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-shape2' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const annotation = annotationRenderInput(deps);
    expect(annotation.kind).toBe('receipt_combined');
    expect(annotationUploadKey(deps)).toBe(invoice.pdf!.blobKey);
    expect(deps.invoiceRepo.applyInvoicePdfRegeneration).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyReceiptPdfRegeneration).not.toHaveBeenCalled();
  });

  it('membership Shape 1 → annotation kind=receipt_combined AND invoiceSubject preserved (US5 WHT-note gate)', async () => {
    const invoice = makeIssuedEventInvoice({
      invoiceSubject: 'membership',
      memberId: 'member-99',
      planId: 'plan-x',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-membership' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const annotation = annotationRenderInput(deps);
    expect(annotation.kind).toBe('receipt_combined');
    // 088 US5 review fix (HIGH) — the credited receipt re-render MUST thread the
    // subject so a membership §86/4 that carried the tenant WHT note keeps it.
    expect(annotation.invoiceSubject).toBe('membership');
  });

  it('zero-rate Shape 1 → annotation carries vatTreatment + cert so the §80/1(5) note survives the credited re-render (US8 review fix)', async () => {
    // A §80/1(5) zero-rated event §86/4 receipt (TIN buyer → receipt_combined).
    // The credited re-render must reproduce the §80/1(5) note + cert reference —
    // the exact twin of the US5 WHT-note gate: the template note gate needs
    // vatTreatment === 'zero_rated_80_1_5' at v>=8, so without threading the pinned
    // triplet the note-less PDF would overwrite the SAME 10y-retention tax receipt.
    const invoice = makeIssuedEventInvoice({
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'กต 0404/1234',
      zeroRateCertDate: '2026-04-10',
      vatRate: VatRate.ofUnsafe('0.0000'),
      vat: Money.fromSatangUnsafe(0n),
      total: Money.fromSatangUnsafe(23_364n), // zero-rate: total === subtotal
      vatInclusive: false,
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us8-zerorate' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const annotation = annotationRenderInput(deps);
    expect(annotation.kind).toBe('receipt_combined');
    expect(annotation.vatTreatment).toBe('zero_rated_80_1_5');
    expect(annotation.zeroRateCertNo).toBe('กต 0404/1234');
  });

  it('CN references the §86/4 RC receipt number + the payment date, NOT the bill number / issue date (T047) — NEW-flow shape: documentNumber NULL', async () => {
    // 088 US6 review — the realistic NEW-flow (taxAtPayment) paid shape: the bill
    // uses a non-§87 SC number so `documentNumber` is NULL, and the §86/4 receipt
    // carries its own payment-time RC. This case (a) exercises the DROPPED
    // `!documentNumber` completeness-guard leg (a documentNumber-NULL parent MUST
    // credit successfully — the primary membership/US1 path) and (b) is the shape
    // where the receipt is dated at the PAYMENT date (render-receipt-pdf: NULL
    // documentNumber → paymentDate), so the §86/10 CN correctly cites paymentDate.
    const invoice = makeIssuedEventInvoice({
      documentNumber: null, // NEW-flow bill uses the SC stream, not §87
      sequenceNumber: null,
      receiptDocumentNumberRaw: 'RC-2026-000045', // the payment-time §86/4 RC number
      // issueDate stays 2026-04-18; paymentDate is 2026-04-19.
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-ref' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const cnRender = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as PdfRenderInput)
      .find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    // References the RC (payment-time §86/4 receipt number), NOT EVT-2026-7.
    expect(cnRender!.creditNote?.originalDocumentNumber).toBe('RC-2026-000045');
    // Reference date is the receipt (payment) date (D7), not the bill issue date.
    expect(cnRender!.creditNote?.originalIssueDate).toBe('2026-04-19');
    // The single synthetic line references the RC number too, in both languages.
    expect(cnRender!.lines[0]!.descriptionEn).toContain('RC-2026-000045');
    expect(cnRender!.lines[0]!.descriptionTh).toContain('RC-2026-000045');
  });

  it('V2 REGRESSION — MEMBERSHIP 088 new-flow parent (documentNumber NULL, SC bill + RC receipt) → SUCCEEDS + CN targets the RC number, never no_snapshot_on_invoice', async () => {
    // The 088 PRIMARY production path: a membership bill in the tax-at-payment
    // flow carries `documentNumber = NULL` — its non-§87 number lives in
    // `billDocumentNumberRaw` and its §86/4 tax number in
    // `receiptDocumentNumberRaw`. issueCreditNote DELIBERATELY dropped the
    // `!loaded.documentNumber` completeness guard so this legitimate row credits.
    // Re-adding that guard would return `no_snapshot_on_invoice` for EVERY
    // production membership credit note while all other tests stayed green — this
    // test is the tripwire. (The sibling T047 test above pins the same for the
    // EVENT shape; this one pins the membership shape + its TIMELINE audit branch.)
    const invoice = makeIssuedEventInvoice({
      invoiceSubject: 'membership',
      memberId: 'member-088',
      planId: 'plan-2026-corporate',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false, // membership is VAT-exclusive
      documentNumber: null, // 088 new-flow bill: §87 doc + seq NULL
      sequenceNumber: null,
      billDocumentNumberRaw: 'SC-2026-000012', // non-§87 ใบแจ้งหนี้ number
      receiptDocumentNumberRaw: 'RC-2026-000034', // §86/4 RC minted at payment
      // factory default: receiptPdf non-null (Shape 1) + receiptPdfStatus 'rendered'.
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-membership-nulldoc' });

    // Succeeds — a documentNumber-NULL membership row is NOT a missing-snapshot row.
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) {
      expect(r.error.code).not.toBe('no_snapshot_on_invoice');
      throw new Error('membership documentNumber-NULL credit note must succeed');
    }

    // The §86/10 CN references the §86/4 RC receipt number. documentNumber is
    // NULL, so the `receiptDocumentNumberRaw ?? documentNumber` resolution MUST
    // land on the RC — never the SC bill number.
    const cnRender = (deps.pdfRender.render as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as PdfRenderInput)
      .find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    expect(cnRender!.creditNote?.originalDocumentNumber).toBe('RC-2026-000034');
    expect(cnRender!.creditNote?.originalDocumentNumber).not.toBe('SC-2026-000012');
    // New-flow (documentNumber NULL) → the receipt is dated at the PAYMENT date (D7).
    expect(cnRender!.creditNote?.originalIssueDate).toBe('2026-04-19');
    // The single synthetic line cites the RC number in both languages.
    expect(cnRender!.lines[0]!.descriptionEn).toContain('RC-2026-000034');
    expect(cnRender!.lines[0]!.descriptionTh).toContain('RC-2026-000034');

    // Membership (memberId non-null) → TIMELINE audit branch carries member_id.
    const cnEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, ev]) => ev.eventType === 'credit_note_issued',
    );
    expect(cnEmit, 'credit_note_issued emit fired').toBeDefined();
    expect((cnEmit![1].payload as Record<string, unknown>).member_id).toBe('member-088');
  });

  it('receipt_not_rendered — a paid parent whose receipt PDF is still pending is BLOCKED before any §87 number is burned', async () => {
    const invoice = makeIssuedEventInvoice({
      receiptPdf: null,
      receiptPdfStatus: 'pending', // async receipt render not yet complete
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-pending' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_rendered, got ok');
    expect(r.error.code).toBe('receipt_not_rendered');
    // Guard runs before allocateNext + render + insert (no side effects).
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
  });

  it('receipt_not_rendered — also blocks a failed receipt render state', async () => {
    const invoice = makeIssuedEventInvoice({
      receiptPdf: null,
      receiptPdfStatus: 'failed',
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-failed' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_rendered, got ok');
    expect(r.error.code).toBe('receipt_not_rendered');
  });

  it('receipt_not_creditable (§105) takes precedence over receipt_not_rendered', async () => {
    // A no-TIN event → receipt_separate (§105). Even if the receipt PDF is not
    // rendered, the LEGAL non-creditability verdict must win (a §105 receipt is
    // NEVER creditable, regardless of render state).
    const invoice = makeIssuedEventInvoice({
      memberIdentitySnapshot: BUYER_SNAP_NO_TIN,
      receiptPdf: null,
      receiptPdfStatus: 'pending',
    });
    const deps = makeDeps(invoice, makeSettings());

    const r = await issueCreditNote(deps, { ...baseInput, requestId: 'req-us6-105-precedence' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected receipt_not_creditable, got ok');
    expect(r.error.code).toBe('receipt_not_creditable');
  });

  // ---- A.7 review fix #2 — sourceRefundId idempotency ownership guard ----

  it('A.7 review fix #2 — REJECTS with concurrent_state_change when the under-lock idempotency read returns a CN for a DIFFERENT invoice (fail-loud, not a silent wrong-CN return)', async () => {
    // `findBySourceRefundId` is keyed on (tenant, sourceRefundId) ONLY — it
    // cannot itself verify the returned CN belongs to the invoice under
    // lock. Not reachable via either real caller today (a refund row binds
    // refundId+invoiceId 1:1 and both callers derive them from the same
    // row), but a mis-wired future caller must get a typed error, never a
    // silent CN for the WRONG invoice.
    const invoice = makeIssuedEventInvoice(); // invoiceId === INVOICE_ID
    const OTHER_INVOICE_ID = '00000000-0000-0000-0000-0000000000ff';
    const mismatchedCn: CreditNote = {
      ...makeCreditNote(
        Money.fromSatangUnsafe(1_000n),
        Money.fromSatangUnsafe(70n),
        Money.fromSatangUnsafe(1_070n),
        null,
      ),
      originalInvoiceId: asInvoiceId(OTHER_INVOICE_ID), // belongs to a DIFFERENT invoice
      sourceRefundId: 'rfnd-mismatched',
    };
    const findBySourceRefundId = vi.fn(async () => mismatchedCn);
    const deps = makeDeps(invoice, makeSettings(), {
      creditNoteRepo: {
        insertCreditNote: vi.fn(),
        findById: vi.fn(),
        findByOriginalInvoice: vi.fn(),
        findByOriginalInvoiceInTx: vi.fn(async () => []),
        listPaged: vi.fn(),
        findBySourceRefundId,
      } as unknown as IssueCreditNoteDeps['creditNoteRepo'],
    });

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-mismatched-refund',
      creditTotalSatang: 1_000n,
      reason: 'refund',
      sourceRefundId: 'rfnd-mismatched',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected concurrent_state_change, got ok');
    expect(r.error.code).toBe('concurrent_state_change');

    // Caught BEFORE any side effect — no §87 number burned, no PDF
    // rendered, no insert, no rollup, no email.
    expect(findBySourceRefundId).toHaveBeenCalledTimes(1);
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('sourceRefundId idempotency — SAME-invoice repeat is unaffected by the ownership guard (returns the existing CN as before)', async () => {
    // Regression guard for fix #2: the legitimate same-invoice repeat path
    // (the only reachable path today) must stay byte-for-byte unchanged.
    const invoice = makeIssuedEventInvoice(); // invoiceId === INVOICE_ID
    const sameCn: CreditNote = {
      ...makeCreditNote(
        Money.fromSatangUnsafe(1_000n),
        Money.fromSatangUnsafe(70n),
        Money.fromSatangUnsafe(1_070n),
        null,
      ),
      originalInvoiceId: asInvoiceId(INVOICE_ID), // SAME invoice — matches
      sourceRefundId: 'rfnd-match',
    };
    const findBySourceRefundId = vi.fn(async () => sameCn);
    const deps = makeDeps(invoice, makeSettings(), {
      creditNoteRepo: {
        insertCreditNote: vi.fn(),
        findById: vi.fn(),
        findByOriginalInvoice: vi.fn(),
        findByOriginalInvoiceInTx: vi.fn(async () => []),
        listPaged: vi.fn(),
        findBySourceRefundId,
      } as unknown as IssueCreditNoteDeps['creditNoteRepo'],
    });

    const r = await issueCreditNote(deps, {
      ...baseInput,
      requestId: 'req-cn-matched-refund',
      creditTotalSatang: 1_000n,
      reason: 'refund',
      sourceRefundId: 'rfnd-match',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.creditNote.creditNoteId).toBe(sameCn.creditNoteId);
    expect(deps.creditNoteRepo.insertCreditNote).not.toHaveBeenCalled();
  });
});
