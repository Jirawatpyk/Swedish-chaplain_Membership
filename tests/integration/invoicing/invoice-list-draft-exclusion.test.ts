/**
 * Integration — `listInvoicesPaged` draft-exclusion guard (060-member-portal-d4).
 *
 * Pre-existing bug (present at 059, not a D4 regression): the member portal
 * invoice list (`src/app/(member)/portal/invoices/page.tsx`) calls
 * `listInvoicesPaged` with `{ includeDrafts: false, status: 'all' }` (the
 * default, when no `?status=` filter is set). The old repo guard
 *
 *     if (!includeDrafts && !opts.status) { status != 'draft' }
 *     ...
 *     else if (opts.status && opts.status !== 'all') { eq(status, opts.status) }
 *
 * skipped the draft-exclusion filter for `status: 'all'` ('all' is truthy, so
 * `!opts.status` is false) AND never reached the specific-status branch
 * (`status !== 'all'` is false) — so DRAFT invoices leaked into the member
 * portal list (badge "Draft"). Members must never see their own draft invoices.
 *
 * The fix treats 'all' the same as an absent status when `includeDrafts: false`:
 *
 *     if (!includeDrafts && (!opts.status || opts.status === 'all')) { ... }
 *
 * This test locks the behaviour against live Neon. It seeds one DRAFT + one
 * ISSUED + one PAID membership invoice for a single member, then asserts:
 *   1. `{ includeDrafts: false, status: 'all' }` → issued + paid, NEVER draft
 *      (the regression guard — FAILS on the old code).
 *   2. `{ includeDrafts: false }` (no status) → also excludes the draft
 *      (unchanged behaviour).
 *   3. `{ includeDrafts: true, status: 'all' }` → INCLUDES the draft
 *      (admin / full-history path preserved).
 *   4. `{ status: 'draft', includeDrafts: false }` → returns ONLY the draft
 *      (explicit draft request still works via the specific-status branch).
 *
 * Lives in tests/integration/** → hits live Neon via runInTenant (RLS); seeds
 * with `tx` from runInTenant, never the global db singleton.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
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
  legal_name: 'Draft Leak Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const MEMBER_ID = '00000000-0000-4000-8000-0000000000f4';

describe('invoice listPaged — draft exclusion when status=all (060-D4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const draftInv = randomUUID();
  const issuedInv = randomUUID();
  const paidInv = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    // Full non-draft snapshot/numbering/pdf field set required by the
    // `invoices_non_draft_has_snapshots` CHECK (migration 0203).
    const nonDraft = (
      invoiceId: string,
      seq: number,
      status: 'issued' | 'paid',
    ) => ({
      tenantId: tenant.ctx.slug,
      invoiceId,
      invoiceSubject: 'membership' as const,
      memberId: MEMBER_ID,
      planYear: 2026,
      planId: 'dl-plan',
      draftByUserId: user.userId,
      status,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `DL-2026-${String(seq).padStart(6, '0')}`,
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
      pdfBlobKey: `invoicing/dl/2026/${seq}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      // PAID rows must carry a non-null receipt_pdf_status per the
      // `invoices_paid_has_receipt_status` CHECK (migration 0056). 'rendered'
      // (combined-mode) is the simplest valid state and satisfies the
      // `invoices_pending_has_receipt_doc_num` CHECK (0061) trivially.
      ...(status === 'paid'
        ? {
            paymentMethod: 'bank_transfer',
            paymentRecordedByUserId: user.userId,
            paymentDate: '2026-01-10',
            paidAt: new Date('2026-01-10T03:00:00Z'),
            receiptPdfStatus: 'rendered' as const,
            receiptPdfBlobKey: `invoicing/dl/2026/${seq}-receipt.pdf`,
            receiptPdfSha256: 'b'.repeat(64),
            receiptPdfTemplateVersion: 1,
          }
        : {}),
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'dl-plan',
        planYear: 2026,
        planName: { en: 'DL Plan' },
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
        invoiceNumberPrefix: 'DL',
        creditNoteNumberPrefix: 'DLC',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: MEMBER_ID,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Draft Leak Co',
        country: 'TH',
        planId: 'dl-plan',
        planYear: 2026,
      });
      await tx.insert(invoices).values([
        // DRAFT — minimal fields (snapshots/numbering/pdf NOT required while
        // status='draft' per the non-draft CHECK).
        {
          tenantId: tenant.ctx.slug,
          invoiceId: draftInv,
          invoiceSubject: 'membership',
          memberId: MEMBER_ID,
          planYear: 2026,
          planId: 'dl-plan',
          draftByUserId: user.userId,
          dueDate: '2026-02-05',
        },
        nonDraft(issuedInv, 1, 'issued'),
        nonDraft(paidInv, 2, 'paid'),
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('status=all + includeDrafts:false → returns issued + paid, NEVER the draft (regression guard)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId: MEMBER_ID,
      status: 'all',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    expect(ids).toEqual([issuedInv, paidInv].sort());
    expect(ids).not.toContain(draftInv);
    expect(result.value.total).toBe(2);
    for (const row of result.value.rows) {
      expect(row.status).not.toBe('draft');
    }
  });

  it('no status filter + includeDrafts:false → also excludes the draft (unchanged behaviour)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId: MEMBER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    expect(ids).toEqual([issuedInv, paidInv].sort());
    expect(ids).not.toContain(draftInv);
    expect(result.value.total).toBe(2);
  });

  it('status=all + includeDrafts:true → INCLUDES the draft (admin / full-history path preserved)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: true,
      memberId: MEMBER_ID,
      status: 'all',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    expect(ids).toEqual([draftInv, issuedInv, paidInv].sort());
    expect(ids).toContain(draftInv);
    expect(result.value.total).toBe(3);
  });

  it('status=draft + includeDrafts:false → returns ONLY the draft (explicit draft request still works)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId: MEMBER_ID,
      status: 'draft',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toEqual([draftInv]);
    expect(result.value.total).toBe(1);
    for (const row of result.value.rows) {
      expect(row.status).toBe('draft');
    }
  });
});
