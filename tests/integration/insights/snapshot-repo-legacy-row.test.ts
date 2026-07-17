/**
 * 067 T6 — pin: a PRE-067 (legacy) `dashboard_metrics_cache` row that lacks
 * `tierDistribution` / `invoiceStatus` MUST fail `snapshotSchema.safeParse`
 * (drizzle-snapshot-repo.ts) so `read()` returns `null`, NOT a
 * `DashboardSnapshot` with `undefined` chart fields.
 *
 * Controller decision (binding, supersedes the original plan text which said
 * to `?? []`-default the two fields): T1 already made both fields REQUIRED in
 * `snapshotSchema`. A legacy row is therefore a parse-reject → treated as a
 * cache miss → `listDashboard`'s existing cold-start path (E3) synchronously
 * recomputes a fresh, valid snapshot. This is the accepted "backfill on read"
 * self-heal, not a bug — do NOT weaken the schema to `.optional()`/`.default()`.
 *
 * This is a live-Neon integration test (not a unit test) because `read()`
 * self-scopes its own `runInTenant` + queries the real `dashboard_metrics_cache`
 * table — there is no framework-free seam to exercise the parse/read mapping
 * without a live tx (CLAUDE.md tenant-scoped-repo convention).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { listDashboard, makeListDashboardDeps } from '@/modules/insights';
import { dashboardMetricsCache } from '@/modules/insights/infrastructure/db/schema-insights';
import { makeDrizzleSnapshotRepo } from '@/modules/insights/infrastructure/repos/drizzle-snapshot-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('067 T6 — snapshotRepo.read() rejects a legacy pre-067 cache row', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-legacy-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();

  // Valid PRE-067 `DashboardSnapshot` shape — everything the OLD schema
  // required, deliberately missing `tierDistribution` + `invoiceStatus`
  // (added by 067). Simulates a row written by the pre-deploy binary.
  const LEGACY_SNAPSHOT_JSON = {
    counts: { total: 1, active: 1, atRisk: 0, overdue: 0 },
    ytdPaidRevenueSatang: '0',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [],
    memberGrowth: [],
    topInsights: [],
    computedAt: '2026-01-01T00:00:00.000Z',
    // NOTE: no tierDistribution / invoiceStatus keys at all.
  };

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Legacy Row Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      // One active member so the recompute path derives a REAL (non-trivial)
      // `tierDistribution` slice — proves genuine self-heal, not a blind
      // default that happens to look populated.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Legacy Row Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        riskScore: null,
        riskScoreBand: null,
      });
      // Seed the legacy cache row DIRECTLY (bypassing `upsertInTx`'s typed
      // `DashboardSnapshot` parameter, which can't express a pre-067 shape).
      await tx.insert(dashboardMetricsCache).values({
        tenantId: tenant.ctx.slug,
        metrics: LEGACY_SNAPSHOT_JSON,
        computedAt: new Date('2026-01-01T00:00:00.000Z'),
        stale: false,
        refreshStartedAt: null,
      });
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('read() parse-rejects the legacy row and returns null (not a snapshot with undefined chart fields)', async () => {
    const repo = makeDrizzleSnapshotRepo(tenant.ctx.slug);
    const result = await repo.read(tenant.ctx);
    expect(result).toBeNull();
  });

  it('listDashboard treats the parse-reject as a cold-start miss and self-heals via recompute — both new chart fields come back populated', async () => {
    const result = await listDashboard(
      { actorUserId: admin.userId, actorRole: 'admin', requestId: `legacy-row-${randomUUID()}` },
      tenant.ctx,
      makeListDashboardDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Real derived data, not a blind `?? []` — one active member on `planId`.
    expect(result.value.metrics.tierDistribution).toHaveLength(1);
    expect(result.value.metrics.tierDistribution[0]).toMatchObject({
      tierKey: planId,
      count: 1,
    });
    // No invoices seeded for this tenant — `getInvoiceStatusDistribution`
    // always returns all 3 buckets (zeroed), plus `draftCount`. The point
    // here isn't the exact figures; it's that the KEY is present + typed
    // (not `undefined`, which is what a legacy row's parsed value would be).
    expect(result.value.metrics.invoiceStatus.draftCount).toBe(0);
    expect(result.value.metrics.invoiceStatus.buckets).toHaveLength(3);

    // The self-heal PERSISTS the upsert — a second read now parses clean.
    const repo = makeDrizzleSnapshotRepo(tenant.ctx.slug);
    const reread = await repo.read(tenant.ctx);
    expect(reread).not.toBeNull();
    expect(reread?.metrics.tierDistribution).toHaveLength(1);
    expect(reread?.metrics.invoiceStatus.draftCount).toBe(0);
    expect(reread?.metrics.invoiceStatus.buckets).toHaveLength(3);
  });
});
