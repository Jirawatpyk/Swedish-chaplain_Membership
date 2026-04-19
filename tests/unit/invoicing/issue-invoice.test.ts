/**
 * CP-3.3 — issue-invoice Application-layer branch coverage.
 *
 * Constitution Principle II requires 100% branch coverage on
 * security-critical use cases. `issue-invoice.ts` is THE critical
 * transactional path in F4 — every failure mode must be tested.
 *
 * Branches exercised:
 *  1. settings_missing                    — tenantSettingsRepo returns null
 *  2. invoice_not_found                   — findDraftById returns null
 *  3. invoice_already_issued (status=issued/paid/void/credited)
 *  4. member_not_found                    — memberIdentity returns null
 *  5. member_archived                     — isArchived = true (FR-037)
 *  6. overflow (sequence > 999_999)       — allocator returns huge seq
 *  7. pdf_render_failed                   — pdfRender.render throws
 *  8. happy path — auto_email tenant default = true → outbox enqueue
 *  9. happy path — draft auto_email_on_issue = false → no outbox
 * 10. happy path — draft auto_email_on_issue = true explicit
 * 11. happy path — tenant auto_email = false + draft null → no outbox
 *
 * Ports are mocked with vi.fn(); the tx parameter is opaque.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';

// ---- Fixtures ---------------------------------------------------------------

const INVOICE_ID = '00000000-0000-0000-0000-000000000001';

function makeDraftInvoice(overrides: Partial<Invoice> = {}): Invoice {
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

  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
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
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    receiptPdf: null,
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 500000n,
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
    registrationDate: '2026-01-15',
    registrationFeePaid: true,
    snapshot: Object.freeze({
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: '123 Road, Bangkok',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
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
      findDraftById: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(async (_tx, input) =>
        ({ ...(draft as Invoice), status: 'issued', fiscalYear: 2026 as never, sequenceNumber: input.sequenceNumber, documentNumber: { raw: input.documentNumber } as never, pdf: input.pdf }) as Invoice,
      ),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      // Default: returns the status of the provided draft fixture so
      // the lock check passes through to findDraftById. Individual
      // tests override this to test status-race branches.
      lockForUpdate: vi.fn(async () => (draft?.status ?? null) as InvoiceStatus | null),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
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
      signDownloadUrl: vi.fn(),
      delete: vi.fn(),
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

  it('invoice_not_found → err', async () => {
    const deps = makeDeps(null, makeSettings(), makeMember());
    const r = await issueInvoice(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
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
});
