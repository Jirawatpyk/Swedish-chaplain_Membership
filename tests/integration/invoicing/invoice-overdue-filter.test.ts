/**
 * Integration — `listInvoicesPaged` overdue filter (go-live audit S1-P0-8... S1-P1-8).
 *
 * 'overdue' is a DERIVED view (status='issued' AND Bangkok-today > dueDate), not
 * a stored status. The repo previously did `eq(status, 'overdue')` → matched
 * ZERO rows, so the admin "Overdue" filter silently returned nothing. This test
 * locks the SQL translation against that regression: it must return exactly the
 * issued + past-due invoices, excluding future-due-issued and (past-due) drafts.
 *
 * Uses fixed far-past / far-future dueDates so the result is stable regardless
 * of the run date (the SQL cutoff is `(now() AT TIME ZONE 'Asia/Bangkok')::date`).
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
  legal_name: 'Overdue Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const PAST_A = '2020-01-01';
const PAST_B = '2020-06-01';
const FUTURE = '2099-12-31';
const MEMBER_ID = '00000000-0000-4000-8000-0000000000d8';

describe('invoice listPaged — overdue filter (S1-P1-8)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const overdue1 = randomUUID();
  const overdue2 = randomUUID();
  const futureDue = randomUUID();
  const draftPastDue = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    const issued = (
      invoiceId: string,
      seq: number,
      issueDate: string,
      dueDate: string,
    ) => ({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId: MEMBER_ID,
      planYear: 2026,
      planId: 'od-plan',
      draftByUserId: user.userId,
      status: 'issued' as const,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `OD-2026-${String(seq).padStart(6, '0')}`,
      issueDate,
      dueDate,
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/od/2026/${seq}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'od-plan',
        planYear: 2026,
        planName: { en: 'OD Plan' },
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
        invoiceNumberPrefix: 'OD',
        creditNoteNumberPrefix: 'ODC',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: MEMBER_ID,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Overdue Co',
        country: 'TH',
        planId: 'od-plan',
        planYear: 2026,
      });
      await tx.insert(invoices).values([
        issued(overdue1, 1, '2026-01-05', PAST_A), // overdue
        issued(overdue2, 2, '2026-01-04', PAST_B), // overdue
        issued(futureDue, 3, '2026-01-03', FUTURE), // issued, NOT overdue
        {
          // draft, past-due — excluded (status != 'issued')
          tenantId: tenant.ctx.slug,
          invoiceId: draftPastDue,
          memberId: MEMBER_ID,
          planYear: 2026,
          planId: 'od-plan',
          draftByUserId: user.userId,
          dueDate: PAST_A,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('returns exactly the issued past-due invoices (not future-due, not drafts)', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      status: 'overdue',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    expect(ids).toEqual([overdue1, overdue2].sort());
    expect(result.value.total).toBe(2);
    // Every returned row is a real issued + past-due invoice.
    for (const row of result.value.rows) {
      expect(row.status).toBe('issued');
      expect(row.dueDate).not.toBeNull();
    }
    expect(ids).not.toContain(futureDue);
    expect(ids).not.toContain(draftPastDue);
  });
});
