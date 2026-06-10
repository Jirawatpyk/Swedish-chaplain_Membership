/**
 * 064 Task 5 — issue-event-invoice-as-paid Application-layer branch coverage.
 *
 * `issueEventInvoiceAsPaid` is the one-shot `draft → paid` issuance for EVENT
 * invoices (ticket settled at the door / bank transfer confirmed): allocate a
 * §87 invoice-stream number, render ONE combined tax-invoice/receipt PDF
 * (ใบกำกับภาษี/ใบเสร็จรับเงิน), and persist the paid row in a single
 * transaction. Security-critical (tax + money) — every failure mode is
 * exercised here, mirroring issue-invoice.test.ts discipline.
 *
 * Branch map:
 *   pre-tx        — payment_date_future (Bangkok wall-clock), settings_missing,
 *                   zod schema (malformed paymentDate)
 *   pre-sequence  — invoice_not_found (+ null-tx probe), invoice_already_issued
 *                   (lock status race), not_event_subject, invalid_lines,
 *                   member_not_found / member_archived / no_buyer_snapshot
 *                   (shared resolveInvoiceBuyerForIssue arms),
 *                   no_tin_numbering_pending (β numbering GATED until Task 10)
 *   post-sequence — overflow, pdf_render_failed (+ post-rollback audit),
 *                   blob_upload_failed (+ orphan-blob delete),
 *                   applyIssueAsPaid conflict (race loser rolls back the seq)
 *   invariants    — canTransition table violation THROWS, vatInclusive=false
 *                   event draft THROWS (Model-B corruption)
 *   happy         — combined-kind pin (even on 'separate' tenants), FY from
 *                   paymentDate, dual audits in-tx + in-order, ONE outbox
 *                   enqueue (privacy footer for non-members), F8 onPaid
 *                   callbacks for matched members only.
 *
 * Ports are mocked with vi.fn(); the tx parameter is the module-level
 * OPAQUE_TX symbol so in-tx audit emission can be asserted by identity.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  issueEventInvoiceAsPaid,
  issueEventInvoiceAsPaidSchema,
} from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { IssueEventInvoiceAsPaidDeps } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId, canTransition } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { InvoiceFixtureOverrides } from '../../helpers/invoice-fixture-overrides';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';

// Mirror issue-invoice.test.ts — stub only the log methods; keep the rest of
// the logger module (PAN regex, child loggers) real via importActual spread.
vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logger')>('@/lib/logger');
  return {
    ...actual,
    logger: { ...actual.logger, warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

// Domain module mocked with importActual spread so ONLY `canTransition` is a
// spy (test "canTransition invariant violation throws"); everything else
// (asInvoiceId, enforceOneSubjectLine, …) stays the real implementation.
vi.mock('@/modules/invoicing/domain/invoice', async () => {
  const actual = await vi.importActual<typeof import('@/modules/invoicing/domain/invoice')>(
    '@/modules/invoicing/domain/invoice',
  );
  return { ...actual, canTransition: vi.fn(actual.canTransition) };
});

// ---- Fixtures ---------------------------------------------------------------

const INVOICE_ID = '00000000-0000-0000-0000-000000000064';
/** Module-level so tests can assert emit/callback tx identity (in-tx, never null). */
const OPAQUE_TX = Symbol('tx');

const INCLUSIVE_SATANG = 107000n; // 1,070.00 THB all-in → subtotal 1,000.00 + VAT 70.00

function makeEventLine(totalSatang: bigint = INCLUSIVE_SATANG): InvoiceLine {
  return {
    lineId: asInvoiceLineId('line-1'),
    kind: 'event_fee',
    descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
    descriptionEn: 'Event: Annual Gala (2026-09-10)',
    unitPrice: Money.fromSatangUnsafe(totalSatang),
    quantity: '1.0000',
    proRateFactor: null,
    total: Money.fromSatangUnsafe(totalSatang),
    position: 1,
  };
}

/**
 * Default draft: NON-member EVENT invoice, buyer snapshot pinned at draft WITH
 * a 13-digit TIN (the happy as-paid TIN path needs no F3 member at all).
 */
function makeEventDraft(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: null,
    planId: null,
    planYear: null,
    invoiceSubject: 'event',
    vatInclusive: true,
    eventId: 'event-uuid-1',
    eventRegistrationId: 'reg-uuid-1',
    status: 'draft',
    draftByUserId: 'actor-user',
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
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: Object.freeze({
      legal_name: 'Beta Imports Ltd',
      tax_id: '9876543210123',
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Buyer',
      primary_contact_email: 'jane@beta.example',
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
    autoEmailOnIssue: null,
    pdf: null,
    pdfDocKind: null,
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [makeEventLine()],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
    // `Invoice` is a discriminated union; the flat `...overrides` spread cannot
    // be re-narrowed to a concrete arm — assert at the factory boundary
    // (established convention, see issue-invoice.test.ts).
  } as Invoice;
}

/** Matched-member event draft — snapshot pinned at ISSUE from the F3 member. */
function makeMatchedEventDraft(overrides: InvoiceFixtureOverrides = {}): Invoice {
  return makeEventDraft({
    memberId: 'member-1',
    memberIdentitySnapshot: null,
    ...overrides,
  });
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
    identity: Object.freeze({
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    }),
    ...overrides,
  };
}

function makeMember(overrides: Partial<MemberIdentityView> = {}): MemberIdentityView {
  return {
    memberId: 'member-1',
    isActive: true,
    isArchived: false,
    memberTypeScope: 'company',
    registrationDate: '2026-01-15',
    registrationFeePaid: true,
    snapshot: Object.freeze({
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: '123 Road, Bangkok',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    }),
    ...overrides,
  };
}

function makeDeps(
  draft: Invoice | null,
  settings: TenantInvoiceSettingsView | null,
  member: MemberIdentityView | null,
  overrides: Partial<IssueEventInvoiceAsPaidDeps> = {},
): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(OPAQUE_TX)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      // Default: surface the fixture's status so the lock check passes
      // through to findByIdInTx; individual tests override for races.
      lockForUpdate: vi.fn(async () => (draft?.status ?? null) as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(async (_tx, applyInput) =>
        ({
          ...(draft as Invoice),
          status: 'paid',
          fiscalYear: applyInput.fiscalYear as never,
          sequenceNumber:
            applyInput.numbering.kind === 'invoice_stream'
              ? applyInput.numbering.sequenceNumber
              : null,
          documentNumber:
            applyInput.numbering.kind === 'invoice_stream'
              ? ({ raw: applyInput.numbering.documentNumber } as never)
              : null,
          issueDate: applyInput.issueDate,
          dueDate: applyInput.issueDate,
          paidAt: '2026-04-18T10:00:00Z',
          paymentDate: applyInput.paymentDate,
          pdf: applyInput.pdf as never,
          pdfDocKind: applyInput.pdfDocKind,
        }) as Invoice,
      ),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    memberIdentity: {
      getForIssue: vi.fn(async () => member),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    audit: {
      emit: vi.fn(async () => {}),
    },
    clock: {
      // Bangkok 2026-04-18 17:00 → local date '2026-04-18'.
      nowIso: () => '2026-04-18T10:00:00Z',
    },
    outbox: {
      enqueue: vi.fn(async () => {}),
    },
    currentTemplateVersion: 1,
    ...overrides,
  };
}

// ---- Tests ------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — 064 Task 5 branch coverage', () => {
  const input = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    requestId: 'req-1',
    invoiceId: INVOICE_ID,
    paymentDate: '2026-04-18',
    paymentMethod: 'bank_transfer' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- schema -----------------------------------------------------------------

  it('schema — malformed paymentDate (slashes / short month) rejected; canonical shape accepted', () => {
    expect(issueEventInvoiceAsPaidSchema.safeParse(input).success).toBe(true);
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentDate: '2026/04/18' }).success,
    ).toBe(false);
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentDate: '2026-4-18' }).success,
    ).toBe(false);
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentMethod: 'stripe_card' }).success,
    ).toBe(false);
  });

  it('schema — shape-valid but IMPOSSIBLE calendar dates rejected; real leap day accepted (review Important #2)', () => {
    // `^\d{4}-\d{2}-\d{2}$` alone accepts 2026-02-31; js-joda would later
    // throw a raw DateTimeParseException → 500. The refine rejects at parse.
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentDate: '2026-02-31' }).success,
    ).toBe(false);
    // 2027 is not a leap year.
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentDate: '2027-02-29' }).success,
    ).toBe(false);
    // 2028 IS a leap year — Feb 29 must remain accepted.
    expect(
      issueEventInvoiceAsPaidSchema.safeParse({ ...input, paymentDate: '2028-02-29' }).success,
    ).toBe(true);
  });

  // --- pre-tx guards ----------------------------------------------------------

  it('payment_date_future — paymentDate after Bangkok today → err, no tx opened, no settings read', async () => {
    // 2026-06-09T18:30:00Z = 2026-06-10 01:30 Bangkok → Bangkok "today" is the 10th.
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      clock: { nowIso: () => '2026-06-09T18:30:00Z' },
    });
    const r = await issueEventInvoiceAsPaid(deps, { ...input, paymentDate: '2026-06-11' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payment_date_future');
    expect(deps.tenantSettingsRepo.getForIssue).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.withTx).not.toHaveBeenCalled();
  });

  it('payment_date boundary — UTC date ≠ Bangkok date: Bangkok-today paymentDate is ACCEPTED', async () => {
    // Same instant: UTC still 2026-06-09 but Bangkok already 2026-06-10 —
    // a UTC-based comparison would wrongly reject the 10th.
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      clock: { nowIso: () => '2026-06-09T18:30:00Z' },
    });
    const r = await issueEventInvoiceAsPaid(deps, { ...input, paymentDate: '2026-06-10' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    // FY derives from the PAYMENT date (Bangkok), not the clock.
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ documentType: 'invoice', fiscalYear: 2026 }),
    );
  });

  it('settings_missing → err (read happens BEFORE withTx — R17-03 pool-deadlock parity)', async () => {
    const deps = makeDeps(makeEventDraft(), null, null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('settings_missing');
    expect(deps.invoiceRepo.withTx).not.toHaveBeenCalled();
  });

  // --- pre-sequence guards ------------------------------------------------------

  it('invoice_not_found → err + null-tx invoice_cross_tenant_probe with route issue-event-invoice-as-paid', async () => {
    const deps = makeDeps(null, makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
    // Probe survives the rollback — emitted with a NULL tx (mirror issueInvoice R7-W1).
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'invoice_cross_tenant_probe',
        payload: expect.objectContaining({
          attempted_invoice_id: input.invoiceId,
          actor_role: 'admin',
          route: 'issue-event-invoice-as-paid',
        }),
      }),
    );
  });

  it.each(['issued', 'paid', 'void', 'credited'] as const)(
    'invoice_already_issued when locked status=%s → err with status',
    async (status) => {
      const deps = makeDeps(makeEventDraft({ status }), makeSettings(), null);
      const r = await issueEventInvoiceAsPaid(deps, input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('invoice_already_issued');
        if (r.error.code === 'invoice_already_issued') expect(r.error.status).toBe(status);
      }
      expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    },
  );

  it('not_event_subject — membership draft → err, allocator untouched', async () => {
    const membershipLine: InvoiceLine = {
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
    const membershipDraft = makeEventDraft({
      invoiceSubject: 'membership',
      memberId: 'member-1',
      planId: 'corporate-regular',
      planYear: 2026,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
      memberIdentitySnapshot: null,
      lines: [membershipLine],
    });
    const deps = makeDeps(membershipDraft, makeSettings(), makeMember());
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_event_subject');
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('invalid_lines — event draft without an event_fee line → err with domain reason', async () => {
    const deps = makeDeps(makeEventDraft({ lines: [] }), makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_lines');
      if (r.error.code === 'invalid_lines') expect(r.error.reason).toBe('no_event_fee_line');
    }
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('member_not_found — matched-member draft whose member row is gone → err', async () => {
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('member_not_found');
  });

  it('member_archived — matched member archived → err, allocator never called (FR-037)', async () => {
    const deps = makeDeps(
      makeMatchedEventDraft(),
      makeSettings(),
      makeMember({ isArchived: true }),
    );
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('member_archived');
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('no_buyer_snapshot — non-member draft with null pinned snapshot → err (data-integrity guard)', async () => {
    const deps = makeDeps(
      makeEventDraft({ memberIdentitySnapshot: null }),
      makeSettings(),
      null,
    );
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_buyer_snapshot');
    expect(deps.memberIdentity.getForIssue).not.toHaveBeenCalled();
  });

  it('member lock uses forUpdate:true (archive-race guard, shared buyer helper)', async () => {
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember());
    await issueEventInvoiceAsPaid(deps, input);
    expect(deps.memberIdentity.getForIssue).toHaveBeenCalledWith(
      OPAQUE_TX,
      'test-swecham',
      'member-1',
      { forUpdate: true },
    );
  });

  // --- no-TIN gate (β numbering pending) ----------------------------------------

  it('no-TIN buyer → err no_tin_numbering_pending BEFORE any allocation (no §87 burn)', async () => {
    const noTinDraft = makeEventDraft({
      memberIdentitySnapshot: Object.freeze({
        legal_name: 'Walk-in Guest',
        tax_id: null,
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Buyer',
        primary_contact_email: 'buyer@example.com',
        member_number: null,
        member_number_display: null,
      }),
    });
    const deps = makeDeps(noTinDraft, makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_tin_numbering_pending');
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyIssueAsPaid).not.toHaveBeenCalled();
  });

  // GATED until Task 10 (β migration) — no-TIN as-paid allocates from the
  // RECEIPT stream (accountant ruling β) once the Task 9 CHECK-relax lands.
  it.skip('β: no-TIN as-paid allocates documentType:"receipt" with the receipt prefix', async () => {
    const noTinDraft = makeEventDraft({
      memberIdentitySnapshot: Object.freeze({
        legal_name: 'Walk-in Guest',
        tax_id: null,
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Buyer',
        primary_contact_email: 'buyer@example.com',
        member_number: null,
        member_number_display: null,
      }),
    });
    const deps = makeDeps(noTinDraft, makeSettings({ receiptNumberPrefix: 'RC' }), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ documentType: 'receipt', fiscalYear: 2026 }),
    );
  });

  // GATED until Task 10 (β migration).
  it.skip('β: no-TIN apply input carries numbering kind receipt_stream + pdfDocKind receipt_separate', async () => {
    const noTinDraft = makeEventDraft({
      memberIdentitySnapshot: Object.freeze({
        legal_name: 'Walk-in Guest',
        tax_id: null,
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Buyer',
        primary_contact_email: 'buyer@example.com',
        member_number: null,
        member_number_display: null,
      }),
    });
    const deps = makeDeps(noTinDraft, makeSettings({ receiptNumberPrefix: 'RC' }), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_separate' }),
    );
    expect(deps.invoiceRepo.applyIssueAsPaid).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({
        numbering: expect.objectContaining({ kind: 'receipt_stream' }),
        pdfDocKind: 'receipt_separate',
      }),
    );
  });

  // --- happy TIN path -------------------------------------------------------------

  it('happy TIN — combined receipt rendered once, invoice-stream number, in-tx dual audits in order, one outbox row', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);

    // ONE render — the combined ใบกำกับภาษี/ใบเสร็จรับเงิน with the as-paid
    // date pin (issue = due = payment date) and the Model-B annotation.
    expect(deps.pdfRender.render).toHaveBeenCalledTimes(1);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'receipt_combined',
        vatInclusive: true,
        issueDate: input.paymentDate,
        dueDate: input.paymentDate,
      }),
    );

    // ONE §87 invoice-stream allocation, FY of the payment date.
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledTimes(1);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ documentType: 'invoice', fiscalYear: 2026 }),
    );

    // applyIssueAsPaid input — numbering union TIN arm + payment threading +
    // back-calculated VAT-inclusive split (107000 = 100000 + 7000).
    expect(deps.invoiceRepo.applyIssueAsPaid).toHaveBeenCalledTimes(1);
    const applyInput = vi.mocked(deps.invoiceRepo.applyIssueAsPaid).mock.calls[0]![1];
    expect(applyInput.numbering).toEqual({
      kind: 'invoice_stream',
      sequenceNumber: 1,
      documentNumber: 'SC-2026-000001',
    });
    expect(applyInput.pdfDocKind).toBe('receipt_combined');
    expect(applyInput.paymentMethod).toBe('bank_transfer');
    expect(applyInput.issueDate).toBe(input.paymentDate);
    expect(applyInput.paymentDate).toBe(input.paymentDate);
    expect(applyInput.paymentRecordedByUserId).toBe('actor-user');
    expect(BigInt(applyInput.totalSatang.toString())).toBe(107000n);
    expect(
      BigInt(applyInput.subtotalSatang.toString()) + BigInt(applyInput.vatSatang.toString()),
    ).toBe(107000n);

    // TWO audits, in order issued → paid, BOTH inside the tx (first arg is
    // the tx handle by identity — never null).
    const emitCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(emitCalls).toHaveLength(2);
    expect(emitCalls[0]![0]).toBe(OPAQUE_TX);
    expect((emitCalls[0]![1] as { eventType: string }).eventType).toBe('invoice_issued');
    expect(emitCalls[1]![0]).toBe(OPAQUE_TX);
    expect((emitCalls[1]![1] as { eventType: string }).eventType).toBe('invoice_paid');

    // ONE outbox enqueue (the paid-receipt email) — non-member buyer carries
    // the PDPA privacy footer flag.
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({
        eventType: 'invoice_paid',
        recipientEmail: 'jane@beta.example',
        privacyFooterKind: 'event_non_member',
      }),
    );
  });

  it("receiptNumberingMode 'separate' tenant → STILL receipt_combined (as-paid override pin)", async () => {
    const deps = makeDeps(
      makeEventDraft(),
      makeSettings({ receiptNumberingMode: 'separate', receiptNumberPrefix: 'RC' }),
      null,
    );
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_combined' }),
    );
    expect(deps.invoiceRepo.applyIssueAsPaid).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ pdfDocKind: 'receipt_combined' }),
    );
    // No receipt-stream allocation either — the §87 number is invoice-stream.
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledTimes(1);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ documentType: 'invoice' }),
    );
  });

  it('requestId undefined → audit rows record requestId null', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    const { requestId: _omit, ...withoutRequestId } = input;
    await issueEventInvoiceAsPaid(deps, withoutRequestId);
    expect(deps.audit.emit).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ requestId: null }),
    );
  });

  // --- audit branch: member vs non-member ----------------------------------------

  it('matched member → audits carry member_id + event_registration_id (F3 timeline branch)', async () => {
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember());
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    const emitCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(emitCalls).toHaveLength(2);
    for (const call of emitCalls) {
      const payload = (call[1] as { payload: Record<string, unknown> }).payload;
      expect(payload.member_id).toBe('member-1');
      expect(payload.event_registration_id).toBe('reg-uuid-1');
      expect(payload.invoice_subject).toBe('event');
    }
    // Paid payload parity with recordPayment.
    const paidPayload = (emitCalls[1]![1] as { payload: Record<string, unknown> }).payload;
    expect(paidPayload.payment_method).toBe('bank_transfer');
    expect(paidPayload.payment_date).toBe(input.paymentDate);
    expect(paidPayload.receipt_document_number).toBe('SC-2026-000001');
    expect(paidPayload.receipt_pdf_async).toBe(false);
  });

  it('non-member → audits omit member_id entirely and carry event_registration_id (non-timeline branch)', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    const emitCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(emitCalls).toHaveLength(2);
    for (const call of emitCalls) {
      const payload = (call[1] as { payload: Record<string, unknown> }).payload;
      expect('member_id' in payload).toBe(false);
      expect(payload.event_registration_id).toBe('reg-uuid-1');
    }
  });

  // --- F8 on-paid callbacks --------------------------------------------------------

  it('matched member → F8 onPaidCallbacks fired with the recordPayment event shape + in-tx handle', async () => {
    const cb = vi.fn(async () => {});
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember(), {
      onPaidCallbacks: [cb],
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'test-swecham',
        invoiceId: INVOICE_ID,
        memberId: 'member-1',
        paidAt: '2026-04-18T10:00:00Z',
        amountSatang: 107000n,
        vatSatang: 7000n,
        currency: 'THB',
        paymentMethod: 'bank_transfer',
        triggeredBy: 'admin_manual',
      }),
      OPAQUE_TX,
    );
  });

  it('non-member → F8 onPaidCallbacks NOT fired (no member to correlate)', async () => {
    const cb = vi.fn(async () => {});
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      onPaidCallbacks: [cb],
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    expect(cb).not.toHaveBeenCalled();
  });

  // --- outbox edge cases -----------------------------------------------------------

  it('empty buyer email → enqueue skipped + warn (ids only) + autoEmailSkipped metric; invoice still issues', async () => {
    const skipMetric = vi.spyOn(invoicingMetrics, 'autoEmailSkipped');
    const deps = makeDeps(
      makeEventDraft({
        memberIdentitySnapshot: Object.freeze({
          legal_name: 'Beta Imports Ltd',
          tax_id: '9876543210123',
          address: '50 Sukhumvit Road, Bangkok 10110',
          primary_contact_name: 'Jane Buyer',
          primary_contact_email: '   ',
          member_number: null,
          member_number_display: null,
        }),
      }),
      makeSettings({ autoEmailEnabled: true }),
      null,
    );
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    expect(skipMetric).toHaveBeenCalledWith('event', 'no_recipient');
    skipMetric.mockRestore();
    const warnArgs = vi.mocked(logger.warn).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(warnArgs).toBeDefined();
    expect(JSON.stringify(warnArgs)).not.toContain('@');
  });

  it('tenant autoEmailEnabled=false → no outbox enqueue (status flip + audits unaffected)', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings({ autoEmailEnabled: false }), null);
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    expect(deps.audit.emit).toHaveBeenCalledTimes(2);
  });

  it('matched member → outbox enqueue WITHOUT the event-non-member footer flag', async () => {
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember());
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = vi.mocked(deps.outbox.enqueue).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(enqueueArg.recipientEmail).toBe('john@acme.example');
    expect(enqueueArg.privacyFooterKind).toBeUndefined();
  });

  // --- FY derivation ---------------------------------------------------------------

  it('FY from paymentDate — clock in 2027 but paymentDate 2026-12-28 → FY 2026 allocation + blobKey embeds 2026', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      clock: { nowIso: () => '2027-01-05T10:00:00Z' },
    });
    const r = await issueEventInvoiceAsPaid(deps, { ...input, paymentDate: '2026-12-28' });
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      OPAQUE_TX,
      expect.objectContaining({ fiscalYear: 2026 }),
    );
    const applyInput = vi.mocked(deps.invoiceRepo.applyIssueAsPaid).mock.calls[0]![1];
    expect(applyInput.fiscalYear).toBe(2026);
    expect(applyInput.pdf.blobKey).toContain('/2026/');
    expect(vi.mocked(deps.blob.uploadPdf).mock.calls[0]![0].key).toContain('/2026/');
  });

  // --- post-sequence failure paths ---------------------------------------------------

  it('overflow — seq > 999_999 → err with fiscalYear (throw-carrier path after allocate)', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      sequenceAllocator: { allocateNext: vi.fn(async () => 1_000_000) },
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('overflow');
      if (r.error.code === 'overflow') expect(r.error.fiscalYear).toBe(2026);
    }
    expect(deps.invoiceRepo.applyIssueAsPaid).not.toHaveBeenCalled();
  });

  it('pdf_render_failed → err + post-rollback null-tx pdf_render_failed audit; applyIssueAsPaid not called', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      pdfRender: {
        render: vi.fn(async () => {
          throw new Error('font load failed');
        }),
      },
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('pdf_render_failed');
      if (r.error.code === 'pdf_render_failed') expect(r.error.reason).toContain('font load failed');
    }
    expect(deps.invoiceRepo.applyIssueAsPaid).not.toHaveBeenCalled();
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'pdf_render_failed',
        payload: expect.objectContaining({ invoice_id: input.invoiceId }),
      }),
    );
  });

  it('blob_upload_failed AFTER allocation → err; applyIssueAsPaid NOT called; best-effort blob.delete with the blobKey', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    deps.blob.uploadPdf = vi.fn(async () => {
      throw new Error('blob 503');
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blob_upload_failed');
    expect(deps.invoiceRepo.applyIssueAsPaid).not.toHaveBeenCalled();
    // Orphan-blob mitigation: a partial upload may exist at the
    // content-addressed key — the outer catch deletes best-effort.
    expect(deps.blob.delete).toHaveBeenCalledWith(
      `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
    );
  });

  it('blob.delete failure during orphan cleanup is swallowed (best-effort) — original error surfaces + WARN logged with the key', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    deps.blob.uploadPdf = vi.fn(async () => {
      throw new Error('blob 503');
    });
    deps.blob.delete = vi.fn(async () => {
      throw new Error('delete also down');
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blob_upload_failed');
    // Review Minor #4 — the failed cleanup is no longer silent: ops needs the
    // key to sweep the orphan manually.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        blobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
        invoiceId: INVOICE_ID,
      }),
      expect.stringContaining('orphan blob cleanup failed'),
    );
  });

  it('applyIssueAsPaid race loser (kind=applyIssueAsPaid) → typed invoice_already_issued via throw-carrier (seq rolls back)', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    deps.invoiceRepo.applyIssueAsPaid = vi.fn(async () => {
      throw new InvoiceApplyConflictError('applyIssueAsPaid');
    });
    const r = await issueEventInvoiceAsPaid(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invoice_already_issued');
      if (r.error.code === 'invoice_already_issued') expect(r.error.status).toBe('issued');
    }
    // Conflict-kind EXCLUSION from orphan cleanup: the race WINNER may own
    // bytes at this deterministic key — the loser must NOT delete them.
    expect(deps.blob.delete).not.toHaveBeenCalled();
  });

  // --- post-apply raw-rethrow paths (review Important #1 + #3) ---------------------
  //
  // Failures AFTER the blob upload that reject the tx via RAW rethrow (not the
  // typed carrier) used to leave an orphan PII blob at the deterministic key —
  // and a retry would see "already exists" → success returning the OLD bytes
  // while the row commits the NEW sha256 (silent tax-document drift). Each
  // rejection below must (a) REJECT the use-case promise (audit-before-success /
  // atomicity contracts) and (b) best-effort delete the uploaded blob.

  const EXPECTED_BLOB_KEY = `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`;

  it('audit.emit rejects on the SECOND in-tx call (invoice_paid, post-apply) → promise REJECTS + orphan blob deleted', async () => {
    const emit = vi
      .fn()
      .mockResolvedValueOnce(undefined) // invoice_issued
      .mockRejectedValueOnce(new Error('audit insert failed')); // invoice_paid
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember(), {
      audit: { emit },
    });
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow('audit insert failed');
    // applyIssueAsPaid had already succeeded — only the audit broke the tx.
    expect(deps.invoiceRepo.applyIssueAsPaid).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(deps.blob.delete).toHaveBeenCalledWith(EXPECTED_BLOB_KEY);
  });

  it('outbox.enqueue throws → promise REJECTS (hard-fail, recordPayment parity) + orphan blob deleted', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null, {
      outbox: {
        enqueue: vi.fn(async () => {
          throw new Error('outbox insert failed');
        }),
      },
    });
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow('outbox insert failed');
    expect(deps.blob.delete).toHaveBeenCalledWith(EXPECTED_BLOB_KEY);
  });

  it('F8 onPaid callback rejects → promise REJECTS (atomic rollback, recordPayment T008 parity) + orphan blob deleted', async () => {
    const cb = vi.fn(async () => {
      throw new Error('F8 listener failed');
    });
    const deps = makeDeps(makeMatchedEventDraft(), makeSettings(), makeMember(), {
      onPaidCallbacks: [cb],
    });
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow('F8 listener failed');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(deps.blob.delete).toHaveBeenCalledWith(EXPECTED_BLOB_KEY);
  });

  it('foreign InvoiceApplyConflictError kinds rethrow (not swallowed into the typed error)', async () => {
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    deps.invoiceRepo.applyIssueAsPaid = vi.fn(async () => {
      throw new InvoiceApplyConflictError('applyPayment');
    });
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow(InvoiceApplyConflictError);
  });

  // --- programming-error invariants (throw, never err) -------------------------------

  it('canTransition table violation → THROWS (broken domain table must crash loudly, pre-allocation)', async () => {
    vi.mocked(canTransition).mockReturnValueOnce({
      ok: false,
      error: { code: 'invalid_transition', from: 'draft', to: 'paid' },
    });
    const deps = makeDeps(makeEventDraft(), makeSettings(), null);
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow(/programming error/);
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('vatInclusive=false event draft (corrupt Model-B state) → THROWS, allocator never called', async () => {
    const deps = makeDeps(makeEventDraft({ vatInclusive: false }), makeSettings(), null);
    await expect(issueEventInvoiceAsPaid(deps, input)).rejects.toThrow(/vatInclusive/);
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });
});
