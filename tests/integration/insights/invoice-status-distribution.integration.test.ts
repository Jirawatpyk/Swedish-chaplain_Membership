/**
 * F9 067-dashboard-interactive-charts Task 4 —
 * `invoiceSourceAdapter.getInvoiceStatusDistribution` against LIVE Neon.
 *
 * Bucket rules (from the 067 design, pinned by this test):
 *   - `paid`    = status 'paid'                          → NET-of-VAT paid
 *                 revenue (mirrors `netPaidRevenueSatang`, the same figure
 *                 `getYtdPaidRevenueSatang` sums — VAT excluded, it's a
 *                 liability, not income).
 *   - `unpaid`  = status 'issued' AND NOT computeIsOverdue → outstanding
 *                 balance (`total − creditedTotal`, VAT-INCLUSIVE — the
 *                 actual amount the member still owes).
 *   - `overdue` = status 'issued' AND computeIsOverdue      → same balance.
 *   - `partially_credited` invoices fold into unpaid/overdue by DUE DATE at
 *     their NET balance. `computeIsOverdue` gates on `status === 'issued'`
 *     (partially_credited never is), so the adapter reuses it via a status
 *     override for the date check only — same Bangkok-date rule, not
 *     re-implemented.
 *   - `draft` is counted separately (`draftCount`); `void` and fully
 *     `credited` are excluded from every bucket AND from `draftCount`.
 *
 * Two isolated tenants:
 *   - Tenant A — the base scenario (paid / issued-future / issued-past-due /
 *     draft / void) using REAL wall-clock time, so the OVERDUE COUNT can be
 *     pinned against `countOverdue(ctx)` — which is hard-coded to
 *     `new Date()` internally (no `nowIso` param on that method). Due dates
 *     are `bangkokLocalDate(now) ± 30 days` so the scenario is stable
 *     regardless of which real calendar day the suite executes on.
 *   - Tenant B — a FIXED synthetic `nowIso` ("2026-07-15T17:30:00.000Z" =
 *     2026-07-16T00:30 Asia/Bangkok, i.e. UTC is still on the PRIOR day)
 *     proves (a) the tz-boundary case (`due_date === today` → NOT overdue)
 *     and (b) the partially_credited fold + full-credit exclusion. This is
 *     kept OUT of Tenant A deliberately: `countOverdue` only lists
 *     `status: 'issued'` invoices, so a partially_credited row folded into
 *     the distribution's overdue bucket would break the Tenant-A equivalence
 *     pin (the two would disagree by exactly the folded row).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { bangkokLocalDate, addDays } from '@/lib/fiscal-year';
import { invoiceSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-source-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SNAP_TENANT = {
  legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
  address_th: 'B', address_en: 'B', logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'C', tax_id: '1', address: 'B',
  primary_contact_name: 'n', primary_contact_email: 't@e.com',
};

type SeedStatus = 'draft' | 'issued' | 'paid' | 'void' | 'partially_credited' | 'credited';

interface SeedInvoiceOpts {
  readonly tenant: TestTenant;
  readonly memberId: string;
  readonly status: SeedStatus;
  readonly dueDate: string | null;
  readonly subtotalSatang?: bigint;
  readonly vatSatang?: bigint;
  readonly totalSatang?: bigint;
  readonly creditedTotalSatang?: bigint;
}

describe('F9 067 Task 4 — invoiceSourceAdapter.getInvoiceStatusDistribution (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const planId = `f9-dist-${randomUUID().slice(0, 8)}`;
  const memberA = randomUUID();
  const memberB = randomUUID();
  let seq = 1;

  function nextSeq(): number {
    return seq++;
  }

  /**
   * Seeds ONE invoice. `draft` needs only the minimal identity fields (no
   * pricing/snapshot); `issued`/`paid`/`void`/`partially_credited`/`credited`
   * are non-draft and must satisfy `invoices_non_draft_has_snapshots` (full
   * snapshot + pdf set) plus the status-specific CHECKs
   * (`invoices_paid_has_payment`, `invoices_void_has_reason`,
   * `invoices_credited_status_matches`). Mirrors the shape used by
   * `tests/integration/renewals/invoice-due-bridge.test.ts`.
   */
  async function seedInvoice(opts: SeedInvoiceOpts): Promise<void> {
    const invoiceId = randomUUID();
    const base = {
      tenantId: opts.tenant.ctx.slug,
      invoiceId,
      memberId: opts.memberId,
      planYear: 2026,
      planId,
      draftByUserId: admin.userId,
      status: opts.status,
      dueDate: opts.dueDate,
    };
    if (opts.status === 'draft') {
      await runInTenant(opts.tenant.ctx, (tx) => tx.insert(invoices).values(base));
      return;
    }
    const n = nextSeq();
    await runInTenant(opts.tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        ...base,
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: n,
        documentNumber: `F9DIST-2026-${String(n).padStart(6, '0')}`,
        issueDate: opts.dueDate ?? '2026-01-01',
        currency: 'THB',
        subtotalSatang: opts.subtotalSatang ?? 0n,
        vatRateSnapshot: '0.0000',
        vatSatang: opts.vatSatang ?? 0n,
        totalSatang: opts.totalSatang ?? 0n,
        creditedTotalSatang: opts.creditedTotalSatang ?? 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/f9dist/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        ...(opts.status === 'void'
          ? { voidedAt: new Date(), voidReason: 'test void', voidedByUserId: admin.userId }
          : {}),
        ...(opts.status === 'paid' ||
        opts.status === 'partially_credited' ||
        opts.status === 'credited'
          ? { paidAt: new Date(), paymentMethod: 'manual', receiptPdfStatus: 'rendered' as const }
          : {}),
      }),
    );
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const two = await createTwoTestTenants();
    tenantA = two.a;
    tenantB = two.b;
    for (const [tenant, memberId] of [
      [tenantA, memberA],
      [tenantB, memberB],
    ] as const) {
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: 'Dist Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Dist Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active' as const,
          riskScore: null,
          riskScoreBand: null,
        });
      });
    }
  }, 180_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  function bucket(
    dist: { readonly buckets: ReadonlyArray<{ bucket: string; satang: bigint; count: number }> },
    name: 'paid' | 'unpaid' | 'overdue',
  ) {
    const found = dist.buckets.find((b) => b.bucket === name);
    if (!found) throw new Error(`bucket ${name} missing from distribution result`);
    return found;
  }

  describe('Tenant A — base scenario + countOverdue equivalence (real time)', () => {
    const todayBkk = bangkokLocalDate(new Date().toISOString());
    const futureDue = addDays(todayBkk, 30);
    const pastDue = addDays(todayBkk, -30);

    beforeAll(async () => {
      // paid: subtotal 100_000 + vat 7_000 = total 107_000 → net-of-VAT
      // revenue is exactly 100_000 (107_000 × 100_000 / 107_000).
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'paid',
        dueDate: pastDue,
        subtotalSatang: 100_000n,
        vatSatang: 7_000n,
        totalSatang: 107_000n,
      });
      // issued, due in the future → unpaid bucket at the full (no-credit)
      // balance.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'issued',
        dueDate: futureDue,
        subtotalSatang: 50_000n,
        vatSatang: 3_500n,
        totalSatang: 53_500n,
      });
      // issued, past its due date → overdue bucket.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'issued',
        dueDate: pastDue,
        subtotalSatang: 80_000n,
        vatSatang: 5_600n,
        totalSatang: 85_600n,
      });
      // draft → draftCount only, no pricing at all.
      await seedInvoice({ tenant: tenantA, memberId: memberA, status: 'draft', dueDate: null });
      // void → excluded from every bucket AND draftCount. Distinct sentinel
      // amount so any leak into a bucket is unmistakable in the assertions.
      await seedInvoice({
        tenant: tenantA,
        memberId: memberA,
        status: 'void',
        dueDate: futureDue,
        subtotalSatang: 42_000n,
        totalSatang: 42_000n,
      });
    }, 60_000);

    it('buckets paid/unpaid/overdue at the correct net amounts + counts, and counts the draft', async () => {
      const nowIso = new Date().toISOString();
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantA.ctx, nowIso);

      expect(bucket(dist, 'paid')).toEqual({ bucket: 'paid', satang: 100_000n, count: 1 });
      expect(bucket(dist, 'unpaid')).toEqual({ bucket: 'unpaid', satang: 53_500n, count: 1 });
      expect(bucket(dist, 'overdue')).toEqual({ bucket: 'overdue', satang: 85_600n, count: 1 });
      expect(dist.draftCount).toBe(1);
    });

    it('the overdue bucket COUNT equals countOverdue(ctx) — same underlying rule, independently derived', async () => {
      const nowIso = new Date().toISOString();
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantA.ctx, nowIso);
      const overdueCount = await invoiceSourceAdapter.countOverdue(tenantA.ctx);
      expect(bucket(dist, 'overdue').count).toBe(overdueCount);
    });
  });

  describe('Tenant B — tz boundary + partially_credited fold + full-credit exclusion (fixed synthetic now)', () => {
    // 2026-07-15T17:30:00.000Z UTC == 2026-07-16T00:30 Asia/Bangkok (UTC+7):
    // Bangkok has already crossed into "2026-07-16" while UTC is still on
    // "2026-07-15" ("prior day").
    const nowIso = '2026-07-15T17:30:00.000Z';
    const todayBkk = '2026-07-16';

    beforeAll(async () => {
      // due_date === today (Bangkok) at 00:30 Bangkok / prior-day UTC → must
      // NOT be overdue (dueDate === todayBkk is not STRICTLY less than it).
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'issued',
        dueDate: todayBkk,
        subtotalSatang: 10_000n,
        totalSatang: 10_000n,
      });
      // partially_credited, clearly past due (30 days before todayBkk) →
      // must fold into OVERDUE at its NET balance (120_000 − 20_000 = 100_000),
      // even though computeIsOverdue's own status gate would normally say
      // "not issued, so never overdue".
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'partially_credited',
        dueDate: addDays(todayBkk, -30),
        subtotalSatang: 120_000n,
        totalSatang: 120_000n,
        creditedTotalSatang: 20_000n,
      });
      // fully credited → excluded from EVERY bucket (not paid, not
      // unpaid/overdue, not draftCount).
      await seedInvoice({
        tenant: tenantB,
        memberId: memberB,
        status: 'credited',
        dueDate: todayBkk,
        subtotalSatang: 30_000n,
        totalSatang: 30_000n,
        creditedTotalSatang: 30_000n,
      });
    }, 60_000);

    it('boundary invoice is NOT overdue; partially_credited folds into overdue at NET balance; fully-credited is invisible', async () => {
      const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(tenantB.ctx, nowIso);

      expect(bucket(dist, 'paid')).toEqual({ bucket: 'paid', satang: 0n, count: 0 });
      // The boundary invoice (10_000, NOT overdue) is the only unpaid row.
      expect(bucket(dist, 'unpaid')).toEqual({ bucket: 'unpaid', satang: 10_000n, count: 1 });
      // The partially_credited invoice (net 100_000) is the only overdue row.
      expect(bucket(dist, 'overdue')).toEqual({ bucket: 'overdue', satang: 100_000n, count: 1 });
      expect(dist.draftCount).toBe(0);
    });
  });
});
