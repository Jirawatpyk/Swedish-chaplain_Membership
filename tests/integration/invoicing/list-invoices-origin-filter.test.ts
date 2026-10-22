/**
 * Integration — `listInvoicesPaged` origin filter (107-auto-invoice Task 13).
 *
 * The admin auto-renewal review queue is defined as `origin='auto_renewal'
 * AND status='draft'`. `listPaged`'s draft-exclusion guard fires whenever
 * `includeDrafts` is false REGARDLESS of what `status` the caller asked for
 * (see `invoice-list-draft-exclusion.test.ts` / bug #15) — so a caller that
 * filters on `origin:'auto_renewal'` without ALSO passing `includeDrafts:
 * true` would silently get an EMPTY result even though matching drafts
 * exist. This is BUG-015 named in this task's brief. The fix forces
 * `includeDrafts` at the `listInvoicesPaged` USE-CASE boundary whenever
 * `input.origin === 'auto_renewal'`, so every caller (not just the admin
 * page) is protected.
 *
 * Seeds one `origin='auto_renewal' status='draft'` invoice, one
 * `origin='manual' status='draft'` invoice, and one `origin='manual'
 * status='issued'` invoice for the SAME member, then asserts:
 *   1. `{ origin:'auto_renewal', status:'draft' }` with NO `includeDrafts`
 *      passed → returns ONLY the auto-renewal draft (BUG-015 proof: drafts
 *      are not silently dropped).
 *   2. `{ origin:'auto_renewal' }` alone (no status) → still returns the
 *      auto-renewal draft (the force applies independent of `status`).
 *   3. `{ origin:'manual' }` → returns the two manual rows, NEVER the
 *      auto-renewal draft.
 *   4. No `origin` filter + `includeDrafts:false` → excludes BOTH drafts
 *      (unchanged pre-existing behaviour — the origin filter must not
 *      widen draft visibility for callers that don't ask for it).
 *
 * Lives in tests/integration/** → hits live Neon via runInTenant (RLS);
 * seeds with `tx` from runInTenant, never the global db singleton.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};
const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Origin Filter Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('listInvoicesPaged — origin filter (107-auto-invoice Task 13, BUG-015)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const memberId = randomUUID();
  const autoDraftInv = randomUUID();
  const manualDraftInv = randomUUID();
  const manualIssuedInv = randomUUID();
  // renewals-suspended-visibility-audit Task 3 — a second ISSUED invoice due
  // in the PRIOR fiscal year (2025-08-15), the prod shape the money band's
  // `?dueBefore={fyStart}` drill-down isolates.
  const priorFyIssuedInv = randomUUID();
  // 124 slice 1 — a second member on a second plan with one issued invoice,
  // so `planId` has something to exclude. The existing cases all filter by
  // `memberId`, so this row is invisible to them.
  const otherMemberId = randomUUID();
  const otherPlanIssuedInv = randomUUID();
  // The same plan id in the 2025 plan year: `planId` matches every year.
  const otherPlanPriorYearInv = randomUUID();
  // Due on Bangkok today: "not yet due" (issued + dueAfter=today), never overdue.
  const dueTodayInv = randomUUID();
  const todayBkk = bangkokLocalDate(new Date().toISOString());
  // An event invoice carries no plan (plan_id NULL): a Plan filter never matches it.
  const eventId = randomUUID();
  const eventRegId = randomUUID();
  const eventInv = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'origin-plan',
        planYear: 2026,
        planName: { en: 'Origin Plan' },
        description: { en: 'desc' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'other-plan',
        planYear: 2026,
        planName: { en: 'Other Plan' },
        description: { en: 'desc' },
        sortOrder: 20,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'other-plan',
        planYear: 2025,
        planName: { en: 'Other Plan' },
        description: { en: 'desc' },
        sortOrder: 20,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: SNAP_TENANT.legal_name_th,
        legalNameEn: SNAP_TENANT.legal_name_en,
        taxId: SNAP_TENANT.tax_id,
        registeredAddressTh: SNAP_TENANT.address_th,
        registeredAddressEn: SNAP_TENANT.address_en,
        invoiceNumberPrefix: 'OF',
        creditNoteNumberPrefix: 'OFC',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Origin Filter Co',
        country: 'TH',
        planId: 'origin-plan',
        planYear: 2026,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: otherMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Other Plan Co',
        country: 'TH',
        planId: 'other-plan',
        planYear: 2026,
      });
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_plan_filter',
        name: 'Plan Filter Gala',
        startDate: new Date('2025-01-15T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: eventRegId,
        eventId,
        externalId: 'att_plan_filter',
        attendeeEmail: 'guest@example.com',
        attendeeName: 'Walk-in Guest',
        attendeeCompany: 'Walk-in Guest Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid',
        registeredAt: new Date('2025-01-10T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
      await tx.insert(invoices).values([
        {
          tenantId: tenant.ctx.slug,
          invoiceId: eventInv,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: eventRegId,
          vatInclusive: true,
          memberId: null,
          planId: null,
          planYear: null,
          draftByUserId: user.userId,
          status: 'paid',
          receiptDocumentNumberRaw: 'RE-2025-000001',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2025-01-15T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2025-01-15',
          fiscalYear: 2025,
          issueDate: '2025-01-15',
          dueDate: '2025-01-15',
          subtotalSatang: 327_103n,
          vatRateSnapshot: '0.0700',
          vatSatang: 22_897n,
          totalSatang: 350_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: null,
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfDocKind: 'receipt_separate',
          pdfBlobKey: 'invoicing/of/re/1.pdf',
          pdfSha256: 'f'.repeat(64),
          pdfTemplateVersion: 8,
        },
        // origin='auto_renewal', status='draft' — the review-queue row.
        {
          tenantId: tenant.ctx.slug,
          invoiceId: autoDraftInv,
          invoiceSubject: 'membership',
          memberId,
          planYear: 2026,
          planId: 'origin-plan',
          draftByUserId: user.userId,
          dueDate: '2026-02-05',
          origin: 'auto_renewal',
        },
        // origin='manual' (default), status='draft'.
        {
          tenantId: tenant.ctx.slug,
          invoiceId: manualDraftInv,
          invoiceSubject: 'membership',
          memberId,
          planYear: 2026,
          planId: 'origin-plan',
          draftByUserId: user.userId,
          dueDate: '2026-02-05',
        },
        // origin='manual' (default), status='issued'.
        {
          tenantId: tenant.ctx.slug,
          invoiceId: manualIssuedInv,
          invoiceSubject: 'membership',
          memberId,
          planYear: 2026,
          planId: 'origin-plan',
          draftByUserId: user.userId,
          status: 'issued',
          pdfDocKind: 'invoice',
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: 'OF-2026-000001',
          issueDate: '2026-01-05',
          dueDate: '2026-02-05',
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/of/2026/1.pdf',
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        },
        // Task 3 — origin='manual', status='issued', due in the PRIOR
        // fiscal year (2025-08-15). Only this row satisfies
        // `dueBefore: '2026-01-01'`.
        {
          tenantId: tenant.ctx.slug,
          invoiceId: priorFyIssuedInv,
          invoiceSubject: 'membership',
          memberId,
          // planYear stays 2026: the composite `invoices_plan_fk`
          // (tenant, plan_id, plan_year) points at the ONE seeded plan row.
          // Only the DUE DATE needs to sit in the prior fiscal year.
          planYear: 2026,
          planId: 'origin-plan',
          draftByUserId: user.userId,
          status: 'issued',
          pdfDocKind: 'invoice',
          fiscalYear: 2025,
          sequenceNumber: 1,
          documentNumber: 'OF-2025-000001',
          issueDate: '2025-07-15',
          dueDate: '2025-08-15',
          subtotalSatang: 3_600_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 252_000n,
          totalSatang: 3_852_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/of/2025/1.pdf',
          pdfSha256: 'b'.repeat(64),
          pdfTemplateVersion: 1,
        },
        // 124 slice 1 — 'other-plan', issued, due 2026-01-01 exactly: the
        // inclusive edge of `dueAfter: '2026-01-01'`.
        {
          tenantId: tenant.ctx.slug,
          invoiceId: otherPlanIssuedInv,
          invoiceSubject: 'membership',
          memberId: otherMemberId,
          planYear: 2026,
          planId: 'other-plan',
          draftByUserId: user.userId,
          status: 'issued',
          pdfDocKind: 'invoice',
          fiscalYear: 2025,
          sequenceNumber: 2,
          documentNumber: 'OF-2025-000002',
          issueDate: '2025-12-02',
          dueDate: '2026-01-01',
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/of/2025/2.pdf',
          pdfSha256: 'c'.repeat(64),
          pdfTemplateVersion: 1,
        },
        {
          tenantId: tenant.ctx.slug,
          invoiceId: otherPlanPriorYearInv,
          invoiceSubject: 'membership',
          memberId: otherMemberId,
          planYear: 2025,
          planId: 'other-plan',
          draftByUserId: user.userId,
          status: 'issued',
          pdfDocKind: 'invoice',
          fiscalYear: 2024,
          sequenceNumber: 1,
          documentNumber: 'OF-2024-000001',
          issueDate: '2024-05-02',
          dueDate: '2024-06-01',
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/of/2024/1.pdf',
          pdfSha256: 'd'.repeat(64),
          pdfTemplateVersion: 1,
        },
        {
          tenantId: tenant.ctx.slug,
          invoiceId: dueTodayInv,
          invoiceSubject: 'membership',
          memberId: otherMemberId,
          planYear: 2026,
          planId: 'other-plan',
          draftByUserId: user.userId,
          status: 'issued',
          pdfDocKind: 'invoice',
          fiscalYear: 2026,
          sequenceNumber: 2,
          documentNumber: 'OF-2026-000002',
          issueDate: '2026-01-05',
          dueDate: todayBkk,
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/of/2026/2.pdf',
          pdfSha256: 'e'.repeat(64),
          pdfTemplateVersion: 1,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('BUG-015: origin=auto_renewal + status=draft + includeDrafts:false (caller forgot to opt in) → still returns ONLY the auto-renewal draft', async () => {
    // `includeDrafts` is a required field on the use-case's input TYPE (the
    // zod schema's `.default(false)` only fills it in when parsing raw
    // JSON — a typed TS caller must still supply it). Passing it explicitly
    // as `false` here proves the USE-CASE forces it to `true` internally
    // whenever `origin==='auto_renewal'`, overriding a caller that forgot —
    // exactly BUG-015's failure mode.
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId,
      origin: 'auto_renewal',
      status: 'draft',
    });
    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toEqual([autoDraftInv]);
    expect(result.value.total).toBe(1);
  });

  it('origin=auto_renewal + includeDrafts:false, NO status filter → still returns the auto-renewal draft (force is status-independent)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId,
      origin: 'auto_renewal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toEqual([autoDraftInv]);
  });

  it('origin=manual → returns the two manual rows, NEVER the auto-renewal draft', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      memberId,
      origin: 'manual',
      status: 'all',
      includeDrafts: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    // Task 3 seed addition: the prior-FY issued row is also origin='manual'.
    expect(ids).toEqual(
      [manualDraftInv, manualIssuedInv, priorFyIssuedInv].sort(),
    );
    expect(ids).not.toContain(autoDraftInv);
  });

  it('no origin filter + includeDrafts:false → excludes BOTH drafts (unchanged pre-existing behaviour)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      memberId,
      includeDrafts: false,
      status: 'all',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    // Task 3 seed addition: both ISSUED rows survive the draft exclusion
    // (ordered issue_date DESC → 2026 first).
    expect(ids).toEqual([manualIssuedInv, priorFyIssuedInv]);
    expect(ids).not.toContain(autoDraftInv);
    expect(ids).not.toContain(manualDraftInv);
  });

  // renewals-suspended-visibility-audit Task 3 — `dueBefore` (strict
  // `due_date < bound`) composes with the existing filters. First consumer:
  // the renewals money band's prior-FY drill-down
  // (`status=overdue&subject=membership&dueBefore={fyStart}`).
  describe('dueBefore filter (Task 3)', () => {
    it('dueBefore=2026-01-01 → ONLY the prior-FY issued bill (strict bound)', async () => {
      const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        memberId,
        status: 'all',
        dueBefore: '2026-01-01',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([priorFyIssuedInv]);
      expect(result.value.total).toBe(1);
    });

    it('composes with the DERIVED overdue status (the money-band drill-down shape)', async () => {
      const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        memberId,
        status: 'overdue',
        invoiceSubject: 'membership',
        dueBefore: '2026-01-01',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both issued bills are past due vs BKK-today, but only the prior-FY
      // one satisfies due_date < 2026-01-01 — the EXACT cohort the band's
      // sub-line counts (the operator-rejected superset is gone).
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([priorFyIssuedInv]);
    });

    it('a later bound (2026-03-01) admits both issued bills; drafts stay excluded (NULL-safe predicate + draft guard)', async () => {
      const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        memberId,
        status: 'all',
        dueBefore: '2026-03-01',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([
        manualIssuedInv,
        priorFyIssuedInv,
      ]);
    });
  });

  // 124 slice 1 — `dueAfter` (inclusive `due_date >= bound`) and `planId`.
  // The dashboard's aging rows link to `status=overdue&dueAfter=…&dueBefore=…`
  // and its Plan filter to `plan=<plan_id>`; both must land on the same rows.
  describe('dueAfter filter (124)', () => {
    const listAll = (input: { dueAfter?: string; dueBefore?: string }) =>
      listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'all',
        ...input,
      });

    it('dueAfter=2026-01-01 is inclusive: the bill due that day and the later one, never the earlier one', async () => {
      const result = await listAll({ dueAfter: '2026-01-01', dueBefore: '2026-06-01' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId).sort()).toEqual(
        [manualIssuedInv, otherPlanIssuedInv].sort(),
      );
      expect(result.value.total).toBe(2);
    });

    it('with dueBefore it is a half-open range [dueAfter, dueBefore)', async () => {
      // dueBefore alone would also admit the 2025-08-15 bill; dueAfter drops it.
      const result = await listAll({ dueAfter: '2025-08-16', dueBefore: '2026-01-02' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([otherPlanIssuedInv]);
    });

    it('a bill due on Bangkok today is "not yet due": issued + dueAfter=today, never overdue', async () => {
      const notYetDue = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'issued',
        dueAfter: todayBkk,
      });
      const overdue = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'overdue',
      });
      expect(notYetDue.ok && overdue.ok).toBe(true);
      if (!notYetDue.ok || !overdue.ok) return;
      expect(notYetDue.value.rows.map((r) => r.invoiceId)).toEqual([dueTodayInv]);
      expect(overdue.value.rows.map((r) => r.invoiceId)).not.toContain(dueTodayInv);
    });

    it('drafts stay excluded even when their due date is in range', async () => {
      const result = await listAll({ dueAfter: '2026-02-01', dueBefore: '2026-06-01' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([manualIssuedInv]);
    });
  });

  describe('planId filter (124)', () => {
    it('keeps only invoices on that plan', async () => {
      const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'all',
        planId: 'other-plan',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Every plan year: the 2025-year invoice of the same plan id matches too;
      // the plan-less event invoice never does.
      expect(result.value.rows.map((r) => r.invoiceId).sort()).toEqual(
        [otherPlanIssuedInv, otherPlanPriorYearInv, dueTodayInv].sort(),
      );
      expect(result.value.total).toBe(3);
      expect(result.value.rows.map((r) => r.invoiceId)).not.toContain(eventInv);
      // …and it is in the tenant's list, so its absence above means something.
      const unfiltered = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'all',
      });
      expect(unfiltered.ok && unfiltered.value.rows.map((r) => r.invoiceId)).toContain(eventInv);
    });

    it('composes with dueAfter and the derived overdue status', async () => {
      const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false,
        status: 'overdue',
        planId: 'origin-plan',
        dueAfter: '2026-01-01',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((r) => r.invoiceId)).toEqual([manualIssuedInv]);
    });
  });
});
