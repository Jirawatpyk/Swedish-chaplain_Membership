/**
 * Integration — invoice list() composite cursor keyset (go-live audit S1-P1-9b).
 *
 * The cursor list sorts `desc(issueDate) [NULLS FIRST], desc(invoiceId)` but the
 * old keyset filtered on `invoiceId` alone — and invoiceId is a RANDOM UUID, not
 * aligned with issueDate — so paging across multiple issueDates skipped/
 * duplicated rows (skewing the F9 insights paginated aggregation). This pins the
 * composite (issueDate, invoiceId) keyset: paging the full set with a small page
 * size must return every row EXACTLY once, in the correct order, with NO
 * skips/dupes — including the NULL-issueDate (draft) group which sorts first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { listInvoices, makeListInvoicesDeps } from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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
  legal_name_th: 'ทดสอบ', legal_name_en: 'Test', tax_id: '0000000000000',
  address_th: 'Bangkok', address_en: 'Bangkok', logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Cursor Co', tax_id: '1234567890123', address: 'Bangkok',
  primary_contact_name: 'n', primary_contact_email: 'test@example.com',
};
const MEMBER_ID = '00000000-0000-4000-8000-0000000000c9';

/** Drain all pages of the cursor list; return ordered invoiceIds. */
async function pageAll(
  tenant: TestTenant,
  opts: { includeDrafts: boolean; pageSize: number },
): Promise<string[]> {
  const deps = makeListInvoicesDeps(tenant.ctx.slug);
  const ids: string[] = [];
  let cursor: string | null = null;
  // Hard cap to avoid an infinite loop if the keyset ever regresses.
  for (let guard = 0; guard < 50; guard += 1) {
    const r = await listInvoices(deps, {
      tenantId: tenant.ctx.slug,
      pageSize: opts.pageSize,
      includeDrafts: opts.includeDrafts,
      cursor,
    });
    if (!r.ok) throw new Error('listInvoices failed');
    for (const row of r.value.rows) ids.push(row.invoiceId as string);
    if (r.value.nextCursor === null) return ids;
    cursor = r.value.nextCursor;
  }
  throw new Error('pageAll: cursor did not terminate (keyset regression?)');
}

describe('invoice list() composite cursor keyset (S1-P1-9b)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  // 5 issued, distinct issueDates (newest → oldest), random UUIDs.
  const issuedNewToOld = [
    { id: randomUUID(), issueDate: '2026-01-05' },
    { id: randomUUID(), issueDate: '2026-01-04' },
    { id: randomUUID(), issueDate: '2026-01-03' },
    { id: randomUUID(), issueDate: '2026-01-02' },
    { id: randomUUID(), issueDate: '2026-01-01' },
  ];
  const draftIds = [randomUUID(), randomUUID()]; // null issueDate → sort FIRST

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    const issued = (id: string, seq: number, issueDate: string) => ({
      tenantId: tenant.ctx.slug, invoiceId: id, memberId: MEMBER_ID,
      planYear: 2026, planId: 'cur-plan', draftByUserId: user.userId,
      status: 'issued' as const, pdfDocKind: 'invoice', fiscalYear: 2026, sequenceNumber: seq,
      documentNumber: `CUR-2026-${String(seq).padStart(6, '0')}`,
      issueDate, dueDate: '2026-03-01',
      subtotalSatang: 100_000n, vatRateSnapshot: '0.0700', vatSatang: 7_000n,
      totalSatang: 107_000n, creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly', netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT, memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/cur/2026/${seq}.pdf`, pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug, planId: 'cur-plan', planYear: 2026,
        planName: { en: 'Cur Plan' }, description: { en: 'd' }, sortOrder: 10,
        planCategory: 'corporate', memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000, includesCorporatePlanId: null,
        minTurnoverMinorUnits: null, maxTurnoverMinorUnits: null,
        maxDurationYears: null, maxMemberAge: null, benefitMatrix: MATRIX,
        isActive: true, createdBy: user.userId, updatedBy: user.userId,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug, currencyCode: 'THB', vatRate: '0.0700',
        registrationFeeSatang: 0n, legalNameTh: SNAP_TENANT.legal_name_th,
        legalNameEn: SNAP_TENANT.legal_name_en, taxId: SNAP_TENANT.tax_id,
        registeredAddressTh: SNAP_TENANT.address_th,
        registeredAddressEn: SNAP_TENANT.address_en,
        invoiceNumberPrefix: 'CUR', creditNoteNumberPrefix: 'CURC',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug, memberId: MEMBER_ID, memberNumber: 1, companyName: 'Cursor Co',
        country: 'TH', planId: 'cur-plan', planYear: 2026,
      });
      await tx.insert(invoices).values([
        ...issuedNewToOld.map((r, i) => issued(r.id, i + 1, r.issueDate)),
        // 2 drafts — null issueDate, minimal fields.
        ...draftIds.map((id) => ({
          tenantId: tenant.ctx.slug, invoiceId: id, memberId: MEMBER_ID,
          planYear: 2026, planId: 'cur-plan', draftByUserId: user.userId,
        })),
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('pages the 5 issued invoices exactly once, in desc(issueDate) order (pageSize=2)', async () => {
    const ids = await pageAll(tenant, { includeDrafts: false, pageSize: 2 });
    // No dupes, no skips, correct order (newest issueDate first).
    expect(ids).toEqual(issuedNewToOld.map((r) => r.id));
  });

  it('with includeDrafts: returns all 7 exactly once (drafts first, then issued desc)', async () => {
    const ids = await pageAll(tenant, { includeDrafts: true, pageSize: 2 });
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7); // no duplicates
    // The 2 drafts (null issueDate) sort FIRST under NULLS FIRST; the 5 issued
    // follow in desc(issueDate). We assert set-membership of the draft prefix +
    // the issued suffix order (draft inter-order is by random invoiceId desc).
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(draftIds));
    expect(ids.slice(2)).toEqual(issuedNewToOld.map((r) => r.id));
  });
});
