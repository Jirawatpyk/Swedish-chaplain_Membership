/**
 * create-invoice-draft — verifies US1 AS1 (registration fee line)
 * and US1 AS2 (pro-rate) against spec acceptance scenarios.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
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
    registrationFeeSatang: asSatang(500000n), // 5,000 THB
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
    memberTypeScope: 'company', // S1-P1-16 (create-draft has no tax_id gate; snapshot has tax_id anyway)
    registrationDate: '2024-06-01',
    registrationFeePaid: true,
    snapshot: {
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: 'TH',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
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
      // Deliberate-duplicate guard: these fixtures each bill a member who
      // holds NO live membership invoice for the plan year, so null is the
      // honest answer, not a paper-over. The guard's own behaviour (refuse /
      // acknowledge / audit) is covered in
      // create-invoice-draft-duplicate-guard.test.ts; overriding this to a
      // non-null row here would silently convert every case below into a
      // duplicate-refusal test.
      findLiveMembershipBillInTx: vi.fn(async () => null),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      findByIdInTxForUpdate: vi.fn(),
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
      // 088 T036 (FR-011) — membership line description = plan name + coverage
      // period. The adapter returns the resolved {th, en} plan name.
      getPlanName: vi.fn(async () => ({ th: 'สมาชิกสามัญ', en: 'Regular Member' })),
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

    it('pro-rate suffix "from/ตั้งแต่" date = the member join date (anchor), NOT the later issue date', async () => {
      // A member who joined mid-FY (2026-03-15) but is invoiced LATER
      // (2026-07-20): the pro-rate factor is anchored to the JOIN date, so the
      // description's "from" date MUST be the registration date, never today's
      // issue date. (Before this fix the suffix printed `issueDate`.)
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2026-03-15' }),
        1_600_000n,
        { clock: { nowIso: () => '2026-07-20T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, baseInput);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.proRateFactor).not.toBe('1.0000'); // suffix must be present
        expect(line.descriptionEn).toContain('from 2026-03-15');
        expect(line.descriptionEn).not.toContain('2026-07-20');
        expect(line.descriptionTh).toContain('ตั้งแต่ 2026-03-15');
        expect(line.descriptionTh).not.toContain('2026-07-20');
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

  // 088 T036 (FR-011) — the membership line description MUST include the plan
  // name. Forward-only issue-time (draft-time) DATA change: the description
  // string is composed here and stored on the invoice line; the PDF template
  // renders the STORED text verbatim, so historical drafts keep their old
  // description and only NEW drafts get the plan + coverage wording.
  //
  // Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — the
  // FY-boundary coverage text these three tests originally asserted is GONE
  // (it contradicted TSCC's rolling-12-months policy). Default text is now
  // `from_payment` (generic "12 months from month of payment"); a caller
  // that HAS resolved an exact period (e.g. an F8 renewal bridge) opts in
  // via `membershipCoverage: { kind: 'window', … }`, which these tests now
  // pass explicitly to keep covering the plan-name + coverage-composition
  // logic (see the `membershipCoverage` describe block below for the
  // default-text + no-planYear-token assertions).
  describe('088 FR-011 — membership line description = plan name + coverage period', () => {
    it('full-cycle draft (window coverage) → description carries the plan name + the exact window dates (both locales)', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly', fiscalYearStartMonth: 1 }),
        makeMember({ registrationDate: '2024-06-01' }), // returning → factor 1.0000
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        // 064 — `toIso` is the EXCLUSIVE next-period start (= periodFrom + term),
        // so [2026-01-01, 2027-01-01) prints "January 2026 - December 2026".
        membershipCoverage: {
          kind: 'window',
          fromIso: '2026-01-01',
          toIso: '2027-01-01',
        },
      }); // planYear 2026, clock 2026-01-15
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        // 064 — {brand} {plan} Membership Fee {year} ({month range}).
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2026\n(January 2026 - December 2026)',
        );
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก สมาชิกสามัญ ปี 2569\n(มกราคม 2569 - ธันวาคม 2569)',
        );
      }
    });

    it('pro-rated draft (window coverage) → description keeps the pro-rate detail AND carries plan name + coverage period', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly', fiscalYearStartMonth: 1 }),
        makeMember({ registrationDate: '2026-07-15' }),
        1_600_000n,
        { clock: { nowIso: () => '2026-07-15T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        membershipCoverage: {
          kind: 'window',
          fromIso: '2026-01-01',
          toIso: '2027-01-01',
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionEn).toContain('Regular Member Membership Fee 2026'); // brand-less label + year
        expect(line.descriptionEn).toContain('(January 2026 - December 2026)'); // coverage period (month-year)
        expect(line.descriptionEn).toContain('pro-rated'); // pro-rate detail retained
        expect(line.descriptionEn).toContain('0.5000');
      }
    });

    it('early renewal (window coverage for a FUTURE period) → coverage = caller-supplied window, NOT wall-clock now (US4 review HIGH)', async () => {
      // A member renews their FY2027 cycle in Dec 2026 (renewal reminders fire
      // before expiry). The §86/4 coverage MUST read the caller-resolved
      // window, not the FY that contains "now" — else the legal document is
      // self-contradictory ("Membership (coverage 2026-01-01 to 2026-12-31)"
      // printed on a document billed in advance for 2027).
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly', fiscalYearStartMonth: 1 }),
        makeMember({ registrationDate: '2024-06-01', registrationFeePaid: true }),
        1_600_000n,
        { clock: { nowIso: () => '2026-12-15T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        planYear: 2027,
        renewalSignal: { unitPriceSatang: 5_000_000n },
        membershipCoverage: {
          kind: 'window',
          fromIso: '2027-01-01',
          toIso: '2028-01-01',
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2027\n(January 2027 - December 2027)',
        );
        // The bug printed the FY containing "now" (2026) on a FY2027 document.
        expect(line.descriptionEn).not.toContain('2026');
        expect(line.descriptionTh).toContain('(มกราคม 2570 - ธันวาคม 2570)');
      }
    });
  });

  // Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) + 064 —
  // `membershipCoverage` text-builder unit coverage: both kinds, TH+EN, the
  // "{year}" token = window START year on the `window` path / planYear on the
  // `from_payment` path, stored verbatim on the line, and the `window` path
  // formats BOTH dates (including truncating a full ISO timestamp to YYYY-MM-DD).
  describe('membershipCoverage — rolling-anchor coverage text (Task 8 + 064)', () => {
    it('default (no membershipCoverage input) → from_payment wording, both locales, year = planYear', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2024-06-01' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, baseInput); // no membershipCoverage
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก สมาชิกสามัญ ปี 2569\n(12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)',
        );
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2026\n(12 months, effective from the month of payment)',
        );
      }
    });

    it('explicit { kind: "from_payment" } → identical to the default wording', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2024-06-01' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        membershipCoverage: { kind: 'from_payment' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก สมาชิกสามัญ ปี 2569\n(12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)',
        );
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2026\n(12 months, effective from the month of payment)',
        );
      }
    });

    it('{ kind: "window" } → exact dates on both locales, stored verbatim, year = window START year, formats a full ISO timestamp via slice(0,10)', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2024-06-01' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        membershipCoverage: {
          kind: 'window',
          fromIso: '2027-06-01T00:00:00.000Z', // full ISO timestamp — must be sliced to date-only
          toIso: '2028-06-01T00:00:00.000Z',
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        // A full ISO timestamp is sliced to date-only before month-year rendering;
        // toIso is exclusive so [2027-06-01, 2028-06-01) → "June 2027 - May 2028".
        // 064 tax review — the "{year}" token is the WINDOW START year (2027 →
        // BE 2570), NOT planYear (2026): the year must agree with the printed
        // window on a §86/4, even when the caller's planYear differs.
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก สมาชิกสามัญ ปี 2570\n(มิถุนายน 2570 - พฤษภาคม 2571)',
        );
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2027\n(June 2027 - May 2028)',
        );
        // Stored verbatim on the persisted invoice line (insertDraft args).
        const stored = (deps as unknown as { _capturedLines: () => Invoice['lines'] })
          ._capturedLines()
          .find((l) => l.kind === 'membership_fee')!;
        expect(stored.descriptionTh).toBe(line.descriptionTh);
        expect(stored.descriptionEn).toBe(line.descriptionEn);
      }
    });

    it('064 — a tenant brand name is prefixed on the line (both locales); omitted when unset', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly', brandName: 'SweCham' }),
        makeMember({ registrationDate: '2024-06-01' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        membershipCoverage: { kind: 'window', fromIso: '2026-08-01', toIso: '2027-08-01' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionEn).toBe(
          'SweCham Regular Member Membership Fee 2026\n(August 2026 - July 2027)',
        );
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก SweCham สมาชิกสามัญ ปี 2569\n(สิงหาคม 2569 - กรกฎาคม 2570)',
        );
      }
    });

    it('064 — a NON-1st-of-month membership start (the imported-member reality) spans exactly the term', async () => {
      // TSCC's "Membership Start" (column G) is rarely the 1st. The window
      // [2026-06-30, 2027-06-30) must print "June 2026 - May 2027" (12 month
      // labels) — end = addMonthsUtc(toIso, -1)'s month, day discarded — never a
      // 13th label or a month drift.
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        makeMember({ registrationDate: '2024-06-01' }),
        1_600_000n,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        membershipCoverage: { kind: 'window', fromIso: '2026-06-30', toIso: '2027-06-30' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.descriptionEn).toBe(
          'Regular Member Membership Fee 2026\n(June 2026 - May 2027)',
        );
        expect(line.descriptionTh).toBe(
          'ค่าสมาชิก สมาชิกสามัญ ปี 2569\n(มิถุนายน 2569 - พฤษภาคม 2570)',
        );
      }
    });
  });

  describe('US1 AS1 — registration-fee line for new members', () => {
    it('new member (registrationFeePaid=false) → gets 2 lines', async () => {
      const deps = makeDeps(
        makeSettings({ registrationFeeSatang: asSatang(500000n) }), // 5,000 THB
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
        makeSettings({ registrationFeeSatang: asSatang(500000n) }),
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
        makeSettings({ registrationFeeSatang: asSatang(0n) }),
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

  // FR-022 (068 speckit-review tests I-1) — UNIT coverage for the
  // `renewalSignal` branch. This is the security-critical price-tampering
  // surface on a renewal §86/4 (the membership line MUST bill the cycle's
  // FROZEN price, NEVER the live F2 catalogue price). Previously covered
  // only by integration; F4 requires 100% BRANCH coverage on this use-case,
  // so the `isRenewal` true-branch needs an in-process unit assertion.
  describe('FR-022 — renewalSignal branch (frozen renewal price)', () => {
    // Frozen renewal price (50,000 THB) deliberately DIFFERS from the live
    // catalogue annual fee (16,000 THB) so a failure to honour the signal
    // (billing the catalogue price) is unambiguous.
    const FROZEN_SATANG = 5_000_000n; // 50,000.00 THB (VAT-exclusive)
    const CATALOGUE_SATANG = 1_600_000n; // 16,000.00 THB

    it('(a) membership line unit price == renewalSignal.unitPriceSatang (frozen), NOT the catalogue getAnnualFeeSatang', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        // Registered in a PRIOR FY (a returning member renewing).
        makeMember({ registrationDate: '2024-06-01', registrationFeePaid: true }),
        CATALOGUE_SATANG, // live catalogue fee — must be IGNORED on renewal
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        renewalSignal: { unitPriceSatang: FROZEN_SATANG },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        // Unit price + total are the FROZEN 50,000 — not the 16,000 catalogue.
        expect(line.unitPrice.toString()).toBe('50000.00 THB');
        expect(line.total.toString()).toBe('50000.00 THB');
      }
    });

    it('(b) no registration_fee line even when registrationFeePaid=false (FR-022 reg-fee suppression on renewal)', async () => {
      const deps = makeDeps(
        makeSettings({ registrationFeeSatang: asSatang(500000n) }), // 5,000 THB configured
        // Unpaid reg fee — on a NON-renewal this would add the reg-fee line.
        makeMember({ registrationFeePaid: false }),
        CATALOGUE_SATANG,
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        renewalSignal: { unitPriceSatang: FROZEN_SATANG },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the membership line — the reg-fee re-bill is suppressed.
        expect(result.value.lines).toHaveLength(1);
        expect(result.value.lines[0]!.kind).toBe('membership_fee');
        expect(
          result.value.lines.some((l) => l.kind === 'registration_fee'),
        ).toBe(false);
      }
    });

    it('(c) proRateFactor === "1.0000" on a mid-FY-join renewal (always a full cycle, never pro-rated)', async () => {
      const deps = makeDeps(
        makeSettings({ proRatePolicy: 'monthly' }),
        // Joined mid-FY: a NON-renewal at this date would pro-rate to 0.5000
        // (see the "mid-July" case above) — the renewal branch forces 1.0000.
        makeMember({ registrationDate: '2026-07-15', registrationFeePaid: true }),
        CATALOGUE_SATANG,
        { clock: { nowIso: () => '2026-07-15T10:00:00Z' } },
      );
      const result = await createInvoiceDraft(deps, {
        ...baseInput,
        renewalSignal: { unitPriceSatang: FROZEN_SATANG },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const line = result.value.lines.find((l) => l.kind === 'membership_fee')!;
        expect(line.proRateFactor).toBe('1.0000');
        // Full frozen price, not 0.5 × anything.
        expect(line.total.toString()).toBe('50000.00 THB');
      }
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
