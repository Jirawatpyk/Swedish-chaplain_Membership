/**
 * T110a — Invoice-list query perf (SC-005).
 *
 * Target: p95 < 500ms for first-page cursor pagination (50 rows) at
 * 5,000-invoice × 2-tenant scale. Mirrors F3 `search-perf.test.ts`
 * (SC-002) — the two cross-cutting list-surfaces share the same
 * p95 contract because they feed the same admin-list UX at the same
 * tenant size.
 *
 * Gated by `RUN_PERF=1` so the 10,000-invoice seed doesn't burn
 * minutes on every CI tick. Skip is observable.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/invoicing/invoice-list-perf.test.ts
 *
 * Why 2 tenants in the seed:
 *   RLS + the `tenant_id = ?` filter in `listPaged` are BOTH expected
 *   to cut the candidate rowset before the ORDER BY. Seeding a second
 *   5,000-row tenant proves the index still bounds p95 when the raw
 *   table size is 10,000 rows (not just the per-tenant 5,000). A
 *   regression that drops the tenant predicate would see the scan
 *   cost double here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
} from '@/modules/invoicing';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const RUN_PERF = process.env.RUN_PERF === '1';

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

const P95_BUDGET_MS = 500;
const ROWS_PER_TENANT = 5_000;
const PAGE_SIZE = 50;
const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 100;

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil(p * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Perf Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'n@n.n',
};

async function seedTenantBaseline(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Perf Plan' },
      description: { en: '' },
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
      invoiceNumberPrefix: 'PRF',
      creditNoteNumberPrefix: 'PRFC',
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Perf Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });
  return memberId;
}

/** Seed ROWS_PER_TENANT issued invoices in batches of 500. */
async function seedInvoices(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
): Promise<void> {
  const batchSize = 500;
  for (let offset = 0; offset < ROWS_PER_TENANT; offset += batchSize) {
    const rows = Array.from({ length: batchSize }, (_, i) => {
      const seq = offset + i + 1;
      return {
        tenantId: tenant.ctx.slug,
        invoiceId: randomUUID(),
        memberId,
        planYear: 2026,
        planId: 'perf-plan',
        draftByUserId: user.userId,
        status: 'issued' as const,
        fiscalYear: 2026,
        sequenceNumber: seq,
        documentNumber: `PRF-2026-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-01-15',
        dueDate: '2026-02-14',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/perf/2026/${seq}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      };
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(invoices).values(rows));
  }
}

describe('T110a — invoice-list query perf (SC-005)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    if (!RUN_PERF) return; // skip heavy seed when gate is off
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    const memberIdA = await seedTenantBaseline(tenantA, user, 'perf-plan');
    const memberIdB = await seedTenantBaseline(tenantB, user, 'perf-plan');
    // Seed both tenants in parallel — each does its own runInTenant tx
    // so the RLS context is per-batch, not cross-contaminated.
    await Promise.all([
      seedInvoices(tenantA, user, memberIdA),
      seedInvoices(tenantB, user, memberIdB),
    ]);
  }, 600_000);

  afterAll(async () => {
    if (!RUN_PERF) return;
    await Promise.all([
      tenantA?.cleanup().catch(() => {}),
      tenantB?.cleanup().catch(() => {}),
    ]);
  });

  it.skipIf(!RUN_PERF)(
    'first-page 50-row listPaged p95 < 500ms at 5,000 rows × 2 tenants',
    async () => {
      const runOnce = async (slug: string): Promise<number> => {
        const t0 = performance.now();
        const r = await listInvoicesPaged(makeListInvoicesDeps(slug), {
          tenantId: slug,
          offset: 0,
          pageSize: PAGE_SIZE,
          status: 'issued',
          includeDrafts: false,
        });
        const elapsed = performance.now() - t0;
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.rows.length).toBeGreaterThan(0);
        return elapsed;
      };

      // Warmup both tenants — first-call cost includes query planner +
      // connection pool + RLS context setup.
      for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
        await runOnce(i % 2 === 0 ? tenantA.ctx.slug : tenantB.ctx.slug);
      }

      const samples: number[] = [];
      for (let i = 0; i < MEASURED_SAMPLES; i += 1) {
        // Alternate tenants so one tenant's cache doesn't dominate
        // — we're measuring the query-plan cost under realistic
        // adversarial load.
        const slug = i % 2 === 0 ? tenantA.ctx.slug : tenantB.ctx.slug;
        samples.push(await runOnce(slug));
      }
      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);
      console.log(
        `[T110a] invoice-list-perf: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${samples.length})`,
      );
      expect(
        p95,
        `p95 ${p95.toFixed(1)}ms exceeded ${P95_BUDGET_MS}ms budget at ${ROWS_PER_TENANT}×2 rows`,
      ).toBeLessThan(P95_BUDGET_MS);
    },
    1_200_000,
  );

  // Smoke — always runs so the file carries weight without RUN_PERF.
  it('smoke: listPaged returns at small scale', async () => {
    const tenant = await createTestTenant('test-swecham');
    try {
      const r = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        offset: 0,
        pageSize: 10,
        includeDrafts: true,
      });
      expect(r.ok).toBe(true);
    } finally {
      await tenant.cleanup().catch(() => {});
    }
  }, 60_000);
});
