/**
 * F9 #4 (integration) — invoiceSourceAdapter.getYtdPaidRevenueSatang windows by
 * the tenant FISCAL year against LIVE Neon, for a NON-January tenant.
 *
 * The unit test (tests/unit/insights/invoice-source-adapter.test.ts) proves the
 * derivation with the real deriveFiscalYear but mocks getForIssue + listInvoices.
 * This closes the live-wiring gap (pr-test-analyzer review): a real
 * tenant_invoice_settings row with fiscalYearStartMonth=4 + real invoices tagged
 * by fiscal year, asserting the KPI sums only the current fiscal year's paid
 * invoices and excludes a calendar-same-year-but-prior-fiscal-year one. Also
 * covers credit-note NETTING at the DB level: a partially-credited invoice must
 * net (total − creditedTotal) into the KPI, not drop out entirely.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoiceSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-source-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F9 #4 invoiceSourceAdapter — fiscal-year YTD on a non-January tenant (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-fy-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();

  const SNAP_TENANT = {
    legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
    address_th: 'B', address_en: 'B', logo_blob_key: null,
  };
  const SNAP_MEMBER = {
    legal_name: 'C', tax_id: '1', address: 'B',
    primary_contact_name: 'n', primary_contact_email: 't@e.com',
  };

  function paidInvoice(
    seq: number,
    fiscalYear: number,
    issueYmd: string,
    totalSatang: bigint,
    opts?: { status?: 'paid' | 'partially_credited' | 'credited'; creditedTotalSatang?: bigint },
  ) {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: admin.userId,
      status: (opts?.status ?? 'paid') as 'paid' | 'partially_credited' | 'credited',
      pdfDocKind: 'invoice',
      fiscalYear,
      sequenceNumber: seq,
      documentNumber: `F9FY-${fiscalYear}-${String(seq).padStart(6, '0')}`,
      issueDate: issueYmd,
      dueDate: issueYmd,
      subtotalSatang: totalSatang,
      vatRateSnapshot: '0.0000',
      vatSatang: 0n,
      totalSatang,
      creditedTotalSatang: opts?.creditedTotalSatang ?? 0n,
      proRatePolicySnapshot: 'monthly' as const,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/f9fy/${seq}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paidAt: new Date(`${issueYmd}T03:00:00.000Z`),
      paymentMethod: 'manual',
      receiptPdfStatus: 'rendered' as const,
    };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // April-start fiscal year (FY n = Apr-n .. Mar-(n+1) in Asia/Bangkok).
    await seedTenantFiscal({ tenant, fiscalYearStartMonth: 4 });
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'FY Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'FY Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active' as const,
        riskScore: null,
        riskScoreBand: null,
      });
      await tx.insert(invoices).values([
        // FY2025 (Apr 2025 .. Mar 2026) — a Feb-2026 paid invoice belongs here.
        paidInvoice(1, 2025, '2026-02-15', 100_000n),
        // FY2026 (Apr 2026 .. Mar 2027) — a Jun-2026 paid invoice belongs here.
        paidInvoice(2, 2026, '2026-06-15', 50_000n),
        // FY2026 — a paid invoice later PARTIALLY CREDITED (80k total, 30k
        // credited). It must NET to 50k, not drop out of the KPI entirely.
        paidInvoice(3, 2026, '2026-06-20', 80_000n, {
          status: 'partially_credited',
          creditedTotalSatang: 30_000n,
        }),
      ]);
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(invoices).where(eq(invoices.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('Feb-2026 (before the April start) → windows by FY2025, excludes the FY2026 invoice', async () => {
    // deriveFiscalYear('2026-02-15…', startMonth=4) = 2025 → only the 100k invoice.
    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      tenant.ctx,
      '2026-02-15T00:00:00.000Z',
    );
    expect(total).toBe(100_000n);
  });

  it('Jun-2026 (after the April start) → windows by FY2026, nets the partially-credited invoice', async () => {
    // deriveFiscalYear('2026-06-15…', startMonth=4) = 2026 → the 50k paid invoice
    // PLUS the partially-credited one netting to 50k (80k − 30k) = 100k. The
    // FY2025 invoice is excluded; the credited invoice is NOT dropped.
    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      tenant.ctx,
      '2026-06-15T00:00:00.000Z',
    );
    expect(total).toBe(100_000n);
  });
});
