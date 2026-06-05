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

// ---- Fixtures ---------------------------------------------------------------

const INVOICE_ID = '00000000-0000-0000-0000-000000000001';
const EVENT_REGISTRATION_ID = '00000000-0000-0000-0000-0000000000aa';
const EVENT_ID = '00000000-0000-0000-0000-0000000000bb';
const FY = fiscalYearFromUtcIso('2026-04-18T10:00:00Z', 1);

const TENANT_SNAP: TenantIdentitySnapshot = Object.freeze({
  legal_name_th: 'หอการค้าไทย-สวีเดน',
  legal_name_en: 'Thailand-Swedish Chamber of Commerce',
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
    receiptPdf: null,
    receiptPdfStatus: null,
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
      lockForUpdate: vi.fn(async () => (invoice?.status ?? null) as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(async () => {}),
      applyInvoicePdfRegeneration: vi.fn(async () => {}),
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
    currentTemplateVersion: 1,
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
      memberIdentitySnapshot: BUYER_SNAP_WITH_EMAIL,
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

  it('does NOT block a MEMBERSHIP invoice with no TIN (subject gate — the guard is event-only)', async () => {
    // A membership invoice can never legitimately be no-TIN (issue-invoice
    // blocks it with tax_id_required), but if such a row existed the §86/10
    // guard MUST NOT fire on it — the block is scoped to invoiceSubject==='event'
    // so membership behaviour is unchanged. We assert the guard is bypassed by
    // observing that the flow proceeds past it to allocateNext.
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
    });

    // The membership invoice is NOT receipt_separate → guard skipped → flow
    // proceeds (succeeds end-to-end through the mocked happy path).
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalled();
  });
});
