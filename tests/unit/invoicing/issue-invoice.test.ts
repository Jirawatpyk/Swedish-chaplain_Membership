/**
 * CP-3.3 — issue-invoice Application-layer branch coverage.
 *
 * Constitution Principle II requires 100% branch coverage on
 * security-critical use cases. `issue-invoice.ts` is THE critical
 * transactional path in F4 — every failure mode must be tested.
 *
 * Branches exercised:
 *  1. settings_missing                    — tenantSettingsRepo returns null
 *  2. invoice_not_found                   — findByIdInTx returns null
 *  3. invoice_already_issued (status=issued/paid/void/credited)
 *  4. member_not_found                    — memberIdentity returns null
 *  5. member_archived                     — isArchived = true (FR-037)
 *  6. overflow (sequence > 999_999)       — allocator returns huge seq
 *  7. pdf_render_failed                   — pdfRender.render throws
 *  8. happy path — auto_email tenant default = true → outbox enqueue
 *  9. happy path — draft auto_email_on_issue = false → no outbox
 * 10. happy path — draft auto_email_on_issue = true explicit
 * 11. happy path — tenant auto_email = false + draft null → no outbox
 * 12. no_buyer_snapshot — non-member event draft with null snapshot
 * 13. VAT-inclusive happy path — splitVatInclusive branch correct total
 *
 * Ports are mocked with vi.fn(); the tx parameter is opaque.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
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

// Task 14 — spy on the structured logger so the empty-recipient skip path
// can assert the `invoice_auto_email_skipped_no_recipient` warn fires with
// ids only (no email/PII). `vi.importActual` keeps every other logger method
// real (PAN regex, child loggers) — we only stub `warn`.
vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logger')>('@/lib/logger');
  return {
    ...actual,
    logger: { ...actual.logger, warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

// ---- Fixtures ---------------------------------------------------------------

const INVOICE_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Default draft factory. Safe defaults match the classic MEMBERSHIP path so
 * existing tests need no changes. Override individual fields to exercise
 * other subjects/branches.
 *
 * The `as Invoice` cast has been dropped so TypeScript enforces that all
 * required Invoice fields are present — missing or misspelled fields produce
 * a compile error rather than silently producing a partial object at runtime.
 */
function makeDraftInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
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

  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    // 054-event-fee-invoices — new discriminator fields; safe defaults keep
    // existing tests on the membership path without any override.
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
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
    memberIdentitySnapshot: null,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    // 064 — NULL on draft only; applyIssue persists the §86/4 gate's kind.
    pdfDocKind: null,
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [membershipLine],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
    // 054-event-fee-invoices — `Invoice` is a discriminated union; the flat
    // `...overrides` spread (subject + identity widened) cannot be re-narrowed
    // to a concrete arm by inference, so assert at the factory boundary (the
    // established convention — see domain/invoice.test.ts). Fixtures may flip
    // membership⇄event or build a CHECK-violating shape for guard tests.
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
    memberTypeScope: 'company', // S1-P1-16 default — snapshot has a tax_id so the gate passes
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

function makeDeps(draft: Invoice | null, settings: TenantInvoiceSettingsView | null, member: MemberIdentityView | null, overrides: Partial<IssueInvoiceDeps> = {}): IssueInvoiceDeps {
  const opaqueTx = Symbol('tx');
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(async (_tx, input) =>
        ({ ...(draft as Invoice), status: 'issued', fiscalYear: 2026 as never, sequenceNumber: input.sequenceNumber, documentNumber: { raw: input.documentNumber } as never, pdf: input.pdf, pdfDocKind: input.pdfDocKind }) as Invoice,
      ),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      // Default: returns the status of the provided draft fixture so
      // the lock check passes through to findByIdInTx. Individual
      // tests override this to test status-race branches.
      lockForUpdate: vi.fn(async () => (draft?.status ?? null) as InvoiceStatus | null),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
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
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: {
      emit: vi.fn(async () => {}),
    },
    clock: {
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

describe('issueInvoice — CP-3.3 branch coverage', () => {
  const input = {
    tenantId: 'test-swecham',
    actorUserId: 'actor-user',
    requestId: 'req-1',
    invoiceId: INVOICE_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settings_missing → err', async () => {
    const deps = makeDeps(makeDraftInvoice(), null, makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('settings_missing');
  });

  it('invoice_not_found → err + emits invoice_cross_tenant_probe (R7-W1)', async () => {
    const deps = makeDeps(null, makeSettings(), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
    // R7-W1 — probe audit fires on lockForUpdate-returns-null (RLS-
    // hidden row looks identical to a truly-missing id). The audit
    // MUST NOT be conflated with the `invoice_issued` audit fired on
    // the happy path — assert only the probe event type is seen.
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'invoice_cross_tenant_probe',
        payload: expect.objectContaining({
          attempted_invoice_id: input.invoiceId,
          actor_role: 'admin',
          route: 'issue-invoice',
        }),
      }),
    );
  });

  it.each(['issued', 'paid', 'void', 'credited'] as const)(
    'invoice_already_issued when status=%s → err (detected via lockForUpdate)',
    async (status) => {
      const deps = makeDeps(
        makeDraftInvoice({ status: status as InvoiceStatus }),
        makeSettings(),
        makeMember(),
      );
      const r = await issueInvoice(deps, input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('invoice_already_issued');
        if (r.error.code === 'invoice_already_issued') expect(r.error.status).toBe(status);
      }
    },
  );

  it('invoice_already_issued — applyIssue race (lock says draft, UPDATE affects 0 rows) maps to typed error', async () => {
    // Scenario: lockForUpdate observed 'draft' but another tx flipped
    // to 'issued' between the lock read and the UPDATE (the
    // applyIssue WHERE status='draft' guard returns 0 rows). The
    // use-case must catch + map to a typed invoice_already_issued
    // error, not a raw 500.
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember());
    deps.invoiceRepo.applyIssue = vi.fn(async () => {
      throw new InvoiceApplyConflictError('applyIssue');
    });
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_already_issued');
  });

  it('member_not_found → err', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), null);
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('member_not_found');
  });

  it('member_archived → err (FR-037)', async () => {
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({ isArchived: true }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('member_archived');
  });

  // --- 054-event-fee-invoices (Task 9) — §86/4 SUBJECT-BASED require-TIN gate.
  //
  // The gate is now subject-based, NOT tier-based: EVERY membership invoice
  // whose buyer snapshot lacks a 13-digit TIN is blocked, regardless of plan
  // memberTypeScope (company/individual/both/null). This closes the
  // ship-blocker where a TIN-less buyer received an illegal full ใบกำกับภาษี.
  // Thai individuals have a national-ID-as-TIN, so a TIN is always obtainable.

  it('tax_id_required — COMPANY-scope membership member with no tax_id → err (§86/4)', async () => {
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({
        memberTypeScope: 'company',
        snapshot: {
          legal_name: 'No-Tax Co',
          tax_id: null,
          address: '123 Road, Bangkok',
          primary_contact_name: 'John Doe',
          primary_contact_email: 'john@acme.example',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tax_id_required');
    // Gate runs BEFORE allocateNext → no §87 sequence number burned.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('tax_id_required — membership member with whitespace-only tax_id → err (trim branch)', async () => {
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({
        memberTypeScope: 'company',
        snapshot: {
          legal_name: 'Blank-Tax Co',
          // Whitespace must be treated as "no tax_id" — the gate trims
          // before the empty check, so this is rejected, not admitted.
          tax_id: '   ',
          address: '123 Road, Bangkok',
          primary_contact_name: 'John Doe',
          primary_contact_email: 'john@acme.example',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tax_id_required');
  });

  it('tax_id_required — INDIVIDUAL-tier membership member without tax_id → err (now subject-based, Task 9)', async () => {
    // BEHAVIOUR CHANGE: under the old tier-based S1-P1-16 gate an individual
    // member was exempt. Now the gate is subject-based — a membership invoice
    // ALWAYS requires a buyer TIN (Thai individuals use their national ID).
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({
        memberTypeScope: 'individual',
        snapshot: {
          legal_name: 'Solo Person',
          tax_id: null,
          address: '123 Road, Bangkok',
          primary_contact_name: 'Jane',
          primary_contact_email: 'jane@example.com',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tax_id_required');
  });

  it('tax_id_required — membership member with null memberTypeScope and no tax_id → err (subject-based, no longer fail-open, Task 9)', async () => {
    // BEHAVIOUR CHANGE: a null scope used to fail open. The subject-based gate
    // keys on `invoiceSubject==='membership'` + missing buyer TIN, so a null
    // scope no longer exempts a TIN-less membership buyer.
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({
        memberTypeScope: null,
        snapshot: {
          legal_name: 'No-Plan Co',
          tax_id: null,
          address: '123 Road, Bangkok',
          primary_contact_name: 'Pat',
          primary_contact_email: 'pat@example.com',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tax_id_required');
  });

  it('membership member WITH a valid tax_id (any tier) → NOT blocked, renders kind:invoice', async () => {
    // An individual-tier member that DOES carry a TIN must pass the gate and
    // render a full tax invoice — proves the gate keys on the TIN, not the tier.
    const deps = makeDeps(
      makeDraftInvoice(),
      makeSettings(),
      makeMember({
        memberTypeScope: 'individual',
        snapshot: {
          legal_name: 'Solo Person',
          tax_id: '1234567890123',
          address: '123 Road, Bangkok',
          primary_contact_name: 'Jane',
          primary_contact_email: 'jane@example.com',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice' }),
    );
  });

  it('overflow — seq > 999_999 → err (FR-035)', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember(), {
      sequenceAllocator: { allocateNext: vi.fn(async () => 1_000_000) },
    });
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('overflow');
  });

  it('pdf_render_failed → err', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember(), {
      pdfRender: {
        render: vi.fn(async () => {
          throw new Error('font load failed');
        }),
      },
    });
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('pdf_render_failed');
      if (r.error.code === 'pdf_render_failed') {
        expect(r.error.reason).toContain('font load failed');
      }
    }
  });

  it('happy path — tenant auto_email=true, draft.autoEmailOnIssue=null → enqueues outbox', async () => {
    const deps = makeDeps(makeDraftInvoice({ autoEmailOnIssue: null }), makeSettings({ autoEmailEnabled: true }), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'invoice_issued' }),
    );
    expect(deps.blob.uploadPdf).toHaveBeenCalledTimes(1);
    expect(deps.invoiceRepo.applyIssue).toHaveBeenCalledTimes(1);
  });

  it('happy path — draft.autoEmailOnIssue=false overrides tenant true → no outbox', async () => {
    const deps = makeDeps(
      makeDraftInvoice({ autoEmailOnIssue: false }),
      makeSettings({ autoEmailEnabled: true }),
      makeMember(),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('happy path — draft.autoEmailOnIssue=true overrides tenant false → enqueues', async () => {
    const deps = makeDeps(
      makeDraftInvoice({ autoEmailOnIssue: true }),
      makeSettings({ autoEmailEnabled: false }),
      makeMember(),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('happy path — both tenant and draft auto_email = false/null → no outbox', async () => {
    const deps = makeDeps(
      makeDraftInvoice({ autoEmailOnIssue: null }),
      makeSettings({ autoEmailEnabled: false }),
      makeMember(),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('member lock uses forUpdate:true (archive-race guard FR-037)', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember());
    await issueInvoice(deps, input);
    expect(deps.memberIdentity.getForIssue).toHaveBeenCalledWith(
      expect.anything(),
      'test-swecham',
      'member-1',
      { forUpdate: true },
    );
  });

  it('sequence allocator receives fiscal year from Bangkok-TZ derivation', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings({ fiscalYearStartMonth: 1 }), makeMember());
    await issueInvoice(deps, input);
    // 2026-04-18T10:00:00Z → Bangkok 17:00 → FY 2026 (Jan-start)
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2026, documentType: 'invoice' }),
    );
  });

  it('requestId undefined → audit payload records null (branch coverage line 211)', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember());
    await issueInvoice(deps, { ...input, requestId: undefined });
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: null }),
    );
  });

  // --- 054-event-fee-invoices (Task 7) new branches --------------------------

  it('no_buyer_snapshot — non-member event draft with null memberIdentitySnapshot → err (data-integrity guard)', async () => {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(10004n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(10004n),
      position: 1,
    };
    const nonMemberEventDraft = makeDraftInvoice({
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-1',
      eventRegistrationId: 'reg-uuid-1',
      memberIdentitySnapshot: null, // the corrupted state the guard defends against
      lines: [eventLine],
    });
    const deps = makeDeps(nonMemberEventDraft, makeSettings(), null /* member irrelevant */);
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_buyer_snapshot');
    // Confirms the member path was NOT entered (getForIssue never called).
    expect(deps.memberIdentity.getForIssue).not.toHaveBeenCalled();
  });

  it('VAT-inclusive branch — splitVatInclusive path: 10004 satang inclusive @ 7% → total 10004 (not 10005), subtotal+vat=total', async () => {
    const INCLUSIVE_SATANG = 10004n; // 100.04 THB — known off-by-1 case under naive recompute
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(INCLUSIVE_SATANG),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(INCLUSIVE_SATANG),
      position: 1,
    };
    const buyerSnapshot = Object.freeze({
      legal_name: 'Beta Imports Ltd',
      tax_id: '9876543210123',
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@beta.example',
      member_number: null,
      member_number_display: null,
    });
    const nonMemberEventDraft = makeDraftInvoice({
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-2',
      eventRegistrationId: 'reg-uuid-2',
      memberIdentitySnapshot: buyerSnapshot,
      lines: [eventLine],
    });
    // Capture what applyIssue was called with so we can assert the VAT amounts.
    let capturedIssueInput: Parameters<IssueInvoiceDeps['invoiceRepo']['applyIssue']>[1] | undefined;
    const deps = makeDeps(nonMemberEventDraft, makeSettings(), null, {
      invoiceRepo: {
        ...makeDeps(nonMemberEventDraft, makeSettings(), null).invoiceRepo,
        applyIssue: vi.fn(async (_tx, issueInput) => {
          capturedIssueInput = issueInput;
          return {
            ...nonMemberEventDraft,
            status: 'issued',
            fiscalYear: 2026 as never,
            sequenceNumber: 1,
            documentNumber: { raw: issueInput.documentNumber } as never,
            pdf: issueInput.pdf,
            pdfDocKind: issueInput.pdfDocKind,
          } as Invoice;
        }),
      },
    });
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(capturedIssueInput).toBeDefined();
    const { subtotalSatang, vatSatang, totalSatang } = capturedIssueInput!;
    expect(totalSatang).toBe(asSatang(INCLUSIVE_SATANG));
    expect(BigInt(totalSatang.toString())).toBe(10004n); // NOT 10005
    expect(BigInt(subtotalSatang.toString()) + BigInt(vatSatang.toString())).toBe(10004n);
    // pro_rate_policy_snapshot is NULL for event (relaxed CHECK migration 0203).
    expect(capturedIssueInput!.proRatePolicySnapshot).toBeNull();
    // Audit emitted via non-timeline branch (no member_id in payload).
    const issuedCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[1] as Record<string,unknown>).eventType === 'invoice_issued',
    );
    expect(issuedCall).toBeDefined();
    const payload = (issuedCall![1] as Record<string, unknown>).payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe('reg-uuid-2');
  });

  // --- 054-event-fee-invoices (Task 9) — §86/4 doc-type kind selection --------
  // --- amended by 064 Task 7 (§105 ROOT FIX) ----------------------------------
  //
  //   EVENT + buyer TIN     → kind 'invoice' (ใบกำกับภาษี — buyer can claim VAT)
  //   EVENT + no buyer TIN  → BLOCK `event_no_tin_requires_paid_issue` — a
  //                           no-TIN event buyer can never be billed first;
  //                           their only legal document is a §105 receipt at
  //                           payment time via issueEventInvoiceAsPaid.
  // and the render input must carry vatInclusive:true for the Model-B annotation.

  /** Build a non-member event draft with a chosen buyer tax_id. */
  function makeEventDraft(taxId: string | null): Invoice {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(107000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(107000n),
      position: 1,
    };
    return makeDraftInvoice({
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-9',
      eventRegistrationId: 'reg-uuid-9',
      memberIdentitySnapshot: Object.freeze({
        legal_name: taxId ? 'Beta Imports Ltd' : 'Walk-in Guest',
        tax_id: taxId,
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Buyer',
        primary_contact_email: 'buyer@example.com',
        member_number: null,
        member_number_display: null,
      }),
      lines: [eventLine],
    });
  }

  it("event + buyer TIN → renders kind:'invoice' (full tax invoice) with vatInclusive:true", async () => {
    const deps = makeDeps(makeEventDraft('9876543210123'), makeSettings(), null);
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice', vatInclusive: true }),
    );
    // 064 — the persisted pdf_doc_kind stays in lockstep with the render kind.
    expect(deps.invoiceRepo.applyIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pdfDocKind: 'invoice' }),
    );
    // Non-member event → never enters the member-lock branch.
    expect(deps.memberIdentity.getForIssue).not.toHaveBeenCalled();
  });

  it('event + NO buyer TIN → err event_no_tin_requires_paid_issue (§105 ROOT FIX)', async () => {
    const deps = makeDeps(makeEventDraft(null), makeSettings(), null);
    const r = await issueInvoice(deps, input);
    // 064 §105 ROOT FIX — a no-TIN event buyer can never be billed first;
    // their only legal document is a §105 receipt, which may exist only at
    // the moment payment is recorded (issueEventInvoiceAsPaid). Plain issue
    // is therefore rejected.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('event_no_tin_requires_paid_issue');
    // Pre-sequence guard → no §87 sequence number burned, nothing rendered.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
  });

  it('event + whitespace-only buyer tax_id → treated as no-TIN → err event_no_tin_requires_paid_issue (trim branch)', async () => {
    const deps = makeDeps(makeEventDraft('   '), makeSettings(), null);
    const r = await issueInvoice(deps, input);
    // Whitespace must be treated as "no TIN" — buyerHasTin trims before the
    // empty check, so this fires the §105 guard, not the full-tax-invoice path.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('event_no_tin_requires_paid_issue');
    // Pre-sequence guard → no §87 sequence number burned.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('matched-member event + member carries a TIN → kind:invoice (member branch, snapshot pinned at issue)', async () => {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(200000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(200000n),
      position: 1,
    };
    const matchedEventDraft = makeDraftInvoice({
      memberId: 'member-1',
      planId: 'corporate-regular',
      planYear: 2026,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-10',
      eventRegistrationId: 'reg-uuid-10',
      memberIdentitySnapshot: null, // pinned at issue for matched member
      lines: [eventLine],
    });
    // Member carries a TIN (makeMember default) → resolves to a full tax invoice.
    const deps = makeDeps(matchedEventDraft, makeSettings(), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice', vatInclusive: true }),
    );
    // 064 — matched-member TIN path persists 'invoice' in lockstep.
    expect(deps.invoiceRepo.applyIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pdfDocKind: 'invoice' }),
    );
  });

  it('matched-member event + member has NO TIN → err event_no_tin_requires_paid_issue (§105 ROOT FIX)', async () => {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(200000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(200000n),
      position: 1,
    };
    const matchedEventDraft = makeDraftInvoice({
      memberId: 'member-1',
      planId: 'corporate-regular',
      planYear: 2026,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-11',
      eventRegistrationId: 'reg-uuid-11',
      memberIdentitySnapshot: null,
      lines: [eventLine],
    });
    const deps = makeDeps(
      matchedEventDraft,
      makeSettings(),
      makeMember({
        memberTypeScope: 'company',
        snapshot: {
          legal_name: 'No-Tax Co',
          tax_id: null,
          address: '123 Road, Bangkok',
          primary_contact_name: 'John Doe',
          primary_contact_email: 'john@acme.example',
          member_number: null,
          member_number_display: null,
        },
      }),
    );
    const r = await issueInvoice(deps, input);
    // 064 §105 ROOT FIX — even a MATCHED member with no TIN cannot be billed
    // first for an event; the fee must be recorded as paid (§105 receipt via
    // issueEventInvoiceAsPaid). Still NOT tax_id_required — the error code is
    // event-specific so the admin UI can point at the record-as-paid flow.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('event_no_tin_requires_paid_issue');
    // Pre-sequence guard → no §87 sequence number burned.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
  });

  it('membership → always renders kind:invoice (gate guarantees a TIN was present)', async () => {
    const deps = makeDeps(makeDraftInvoice(), makeSettings(), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice', vatInclusive: false }),
    );
  });

  // --- 054-event-fee-invoices (Task 14) — auto-email hardening -----------------
  //   (A) empty-recipient guard: a non-member event buyer with an empty
  //       contact email → SKIP enqueue + warn (ids only), invoice still issues.
  //   (B) non-member event privacy footer: enqueue carries
  //       privacyFooterKind:'event_non_member'.
  //   regression: membership invoice enqueue carries NO footer flag.

  /** Non-member event draft with a chosen buyer contact email (tax_id pinned). */
  function makeNonMemberEventDraftWithEmail(contactEmail: string): Invoice {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      unitPrice: Money.fromSatangUnsafe(107000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(107000n),
      position: 1,
    };
    return makeDraftInvoice({
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-14',
      eventRegistrationId: 'reg-uuid-14',
      memberIdentitySnapshot: Object.freeze({
        legal_name: 'Walk-in Guest',
        tax_id: '9876543210123',
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Buyer',
        primary_contact_email: contactEmail,
        member_number: null,
        member_number_display: null,
      }),
      lines: [eventLine],
    });
  }

  it('(A) non-member event, auto-email ON, EMPTY buyer email → no enqueue, warn fires + metric bumps, invoice still issues', async () => {
    // Observability parity (054 speckit-review) — assert the dedicated
    // `autoEmailSkipped` counter bumps so ops can alert on the otherwise-silent
    // skip, not just the warn log.
    const skipMetric = vi.spyOn(invoicingMetrics, 'autoEmailSkipped');
    const deps = makeDeps(
      makeNonMemberEventDraftWithEmail(''),
      makeSettings({ autoEmailEnabled: true }),
      null,
    );
    const r = await issueInvoice(deps, input);
    // Invoice still issues successfully — email is best-effort, not a tx invariant.
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    // No enqueue to the empty address.
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    // Metric bumped with the event subject + no_recipient reason.
    expect(skipMetric).toHaveBeenCalledWith('event', 'no_recipient');
    skipMetric.mockRestore();
    // Skip warn fires with ids only (no email/PII).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invoice_auto_email_skipped_no_recipient',
        tenantId: input.tenantId,
        invoiceSubject: 'event',
      }),
      expect.any(String),
    );
    // Defence-in-depth: the buyer's (empty) email never appears in the log
    // call arg — assert no field on the warn payload carries an email value.
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(warnArgs).toBeDefined();
    expect(JSON.stringify(warnArgs)).not.toContain('primary_contact_email');
    expect(JSON.stringify(warnArgs)).not.toContain('@');
  });

  it('(A) whitespace-only buyer email → treated as empty → no enqueue, warn fires', async () => {
    const deps = makeDeps(
      makeNonMemberEventDraftWithEmail('   '),
      makeSettings({ autoEmailEnabled: true }),
      null,
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'invoice_auto_email_skipped_no_recipient' }),
      expect.any(String),
    );
  });

  it('(B) non-member event, auto-email ON, buyer HAS email → enqueues with privacyFooterKind:event_non_member', async () => {
    const deps = makeDeps(
      makeNonMemberEventDraftWithEmail('buyer@walkin.example'),
      makeSettings({ autoEmailEnabled: true }),
      null,
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_issued',
        recipientEmail: 'buyer@walkin.example',
        privacyFooterKind: 'event_non_member',
      }),
    );
    // Skip warn must NOT fire on the happy enqueue path.
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'invoice_auto_email_skipped_no_recipient' }),
      expect.anything(),
    );
  });

  it('(regression) membership invoice, auto-email ON → enqueues WITHOUT the event-non-member footer flag', async () => {
    const deps = makeDeps(
      makeDraftInvoice({ autoEmailOnIssue: null }),
      makeSettings({ autoEmailEnabled: true }),
      makeMember(),
    );
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = (deps.outbox.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(enqueueArg.recipientEmail).toBe('john@acme.example');
    // No footer flag for a membership invoice (the buyer is a known member).
    expect(enqueueArg.privacyFooterKind).toBeUndefined();
  });

  it('(regression) matched-member EVENT invoice → enqueues WITHOUT the footer flag (member, not walk-in)', async () => {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน',
      descriptionEn: 'Event',
      unitPrice: Money.fromSatangUnsafe(200000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(200000n),
      position: 1,
    };
    const matchedEventDraft = makeDraftInvoice({
      memberId: 'member-1',
      planId: 'corporate-regular',
      planYear: 2026,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-uuid-14b',
      eventRegistrationId: 'reg-uuid-14b',
      memberIdentitySnapshot: null, // pinned at issue from the member row
      lines: [eventLine],
    });
    const deps = makeDeps(matchedEventDraft, makeSettings({ autoEmailEnabled: true }), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = (deps.outbox.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    // memberId is non-null → the footer is for NON-member buyers only.
    expect(enqueueArg.privacyFooterKind).toBeUndefined();
  });
});

