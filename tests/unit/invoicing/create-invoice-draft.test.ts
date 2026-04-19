/**
 * create-invoice-draft — verifies US1 AS1 (registration fee line)
 * and US1 AS2 (pro-rate) against spec acceptance scenarios.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import type { CreateInvoiceDraftDeps } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: 500000n, // 5,000 THB
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
      tax_id: '0',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    ...overrides,
  };
}

function makeMember(overrides: Partial<MemberIdentityView> = {}): MemberIdentityView {
  return {
    memberId: '00000000-0000-0000-0000-00000000aaaa',
    isActive: true,
    isArchived: false,
    registrationDate: '2024-06-01',
    registrationFeePaid: true,
    snapshot: {
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: 'TH',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
    },
    ...overrides,
  };
}

function makeDeps(
  settings: TenantInvoiceSettingsView | null,
  member: MemberIdentityView | null,
  annualFeeSatang: bigint | null,
  overrides: Partial<CreateInvoiceDraftDeps> = {},
): CreateInvoiceDraftDeps {
  let uuidCounter = 0;
  let insertedLines: Invoice['lines'] = [];
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn({})),
      insertDraft: vi.fn(async (_tx, args) => {
        insertedLines = args.lines;
        return {
          tenantId: args.tenantId,
          invoiceId: asInvoiceId(args.invoiceId),
          memberId: args.memberId,
          planId: args.planId,
          planYear: args.planYear,
          status: 'draft',
          draftByUserId: args.draftByUserId,
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
          autoEmailOnIssue: args.autoEmailOnIssue,
          pdf: null,
          receiptPdf: null,
          lines: args.lines,
          createdAt: '2026-04-18T00:00:00Z',
          updatedAt: '2026-04-18T00:00:00Z',
        } as Invoice;
      }),
      findByIdInTx: vi.fn(),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () => 'issued' as const),
    },
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
    },
    memberIdentity: {
      getForIssue: vi.fn(async () => member),
    },
    planLookup: {
      getAnnualFeeSatang: vi.fn(async () => annualFeeSatang),
    },
    audit: { emit: vi.fn(async () => {}) },
    clock: { nowIso: () => '2026-01-15T10:00:00Z' }, // mid-January Bangkok
    newUuid: () => `${++uuidCounter}-uuid`,
    ...overrides,
    _capturedLines: () => insertedLines,
  } as unknown as CreateInvoiceDraftDeps & { _capturedLines: () => Invoice['lines'] };
}

const baseInput = {
  tenantId: 'test-swecham',
  actorUserId: 'admin-user',
  requestId: 'req-1',
  memberId: '00000000-0000-0000-0000-00000000aaaa',
  planId: 'regular',
  planYear: 2026,
} as const;

describe('createInvoiceDraft — US1 AS1 + AS2 spec verification', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('US1 AS2 — pro-rate policy', () => {
    it('returning member (registered prior year) → factor = 1.0 (full year)', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2024-06-01' }), // prior FY
        1_600_000n, // 16,000 THB annual
      );
      const result = await createInvoiceDraft(deps, baseInput);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const membershipLine = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(membershipLine.proRateFactor).toBe('1.0000');
        expect(membershipLine.total.toString()).toBe('16000.00 THB');
      }
    });

    it('new member joining mid-January 2026 (month 1) → factor = 12/12 = 1.0', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2026-01-15' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, baseInput);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.proRateFactor).toBe('1.0000');
      }
    });

    it('new member joining mid-July 2026 → factor = 6/12 = 0.5 (6 months remaining)', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2026-07-15' }),
        1_600_000n,
        { clock: { nowIso: () => '2026-07-15T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, baseInput);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.proRateFactor).toBe('0.5000');
        expect(line.total.toString()).toBe('8000.00 THB');
        expect(line.descriptionEn).toContain('pro-rated');
        expect(line.descriptionEn).toContain('0.5000');
      }
    });

    it("policy 'none' → factor always 1.0 regardless of join date", async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'none' }),
        makeMember({ registrationDate: '2026-12-15' }), // joined very late
        1_600_000n,
        { clock: { nowIso: () => '2026-12-15T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, baseInput);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.proRateFactor).toBe('1.0000');
        expect(line.total.toString()).toBe('16000.00 THB');
      }
    });
  });

  describe('US1 AS1 — registration-fee line for new members', () => {
    it('new member (registrationFeePaid=false) → gets 2 lines', async () => {
      const deps = makeDeps(
        makeSettings({ registrationFeeSatang: 500000n }), // 5,000 THB
        makeMember({ registrationFeePaid: false }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, baseInput);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.lines).toHaveLength(2);
        const reg = result.value.lines.find((l) => l.kind === 'registration_fee')!;
        expect(reg.total.toString()).toBe('5000.00 THB');
        expect(reg.proRateFactor).toBeNull();
      }
    });

    it('returning member (registrationFeePaid=true) → only 1 line (membership)', async () => {
      const deps = makeDeps(
        makeSettings({ registrationFeeSatang: 500000n }),
        makeMember({ registrationFeePaid: true }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, baseInput);
      if (result.ok) {
        expect(result.value.lines).toHaveLength(1);
        expect(result.value.lines[0]!.kind).toBe('membership_fee');
      }
    });

    it('tenant without registration fee configured (0 satang) → no reg line even for new member', async () => {
      const deps = makeDeps(
        makeSettings({ registrationFeeSatang: 0n }),
        makeMember({ registrationFeePaid: false }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, baseInput);
      if (result.ok) {
        expect(result.value.lines).toHaveLength(1);
        expect(result.value.lines[0]!.kind).toBe('membership_fee');
      }
    });
  });

  describe('error branches', () => {
    it('settings_missing', async () => {
      const deps = makeDeps(null, makeMember(), 1_600_000n);
      const r = await createInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('settings_missing');
    });

    it('member_not_found', async () => {
      const deps = makeDeps(makeSettings(), null, 1_600_000n);
      const r = await createInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('member_not_found');
    });

    it('member_archived', async () => {
      const deps = makeDeps(makeSettings(), makeMember({ isArchived: true }), 1_600_000n);
      const r = await createInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('member_archived');
    });

    it('plan_not_found', async () => {
      const deps = makeDeps(makeSettings(), makeMember(), null);
      const r = await createInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('plan_not_found');
    });
  });

  it('emits invoice_draft_created audit with pro_rate_factor + registration_fee_included in payload', async () => {
    const deps = makeDeps(
      makeSettings(),
      makeMember({ registrationFeePaid: false, registrationDate: '2026-07-15' }),
      1_600_000n,
      { clock: { nowIso: () => '2026-07-15T10:00:00Z' } },
    );
    await createInvoiceDraft(deps, baseInput);
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_draft_created',
        payload: expect.objectContaining({
          pro_rate_factor: '0.5000',
          registration_fee_included: true,
        }),
      }),
    );
  });
});
