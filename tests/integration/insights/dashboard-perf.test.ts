/**
 * Dashboard perf gate (T098 → F9 US1 / SC-002).
 *
 * Seeds 5,000 members for one tenant and measures the dashboard data path.
 * SC-002 sets the budget at **p95 < 1.5 s for full interactive render at a
 * 5,000-member tenant**.
 *
 * Two measurements (the render itself is a Next concern, not vitest-testable;
 * this gates the data path that feeds it):
 *   1. `listDashboard` (the USER-FACING read) — an O(1) single-row PK lookup on
 *      `dashboard_metrics_cache` (member-count-independent by design). This is
 *      the SC-002 data path; it must sit well under the 1.5 s render budget.
 *   2. `computeDashboardSnapshot` @ 5k (the offline every-5-min CRON cost) — the only
 *      scale-dependent path. NOT part of SC-002's render budget (the user reads
 *      the cache, not the compute). Its only real constraint is FR-005 freshness:
 *      it must finish well inside the 5-min cron window so the cache never goes
 *      stale. Local Bangkok→Neon-SG measures ~18 s @ 5k — that is the cross-region
 *      RTT tax on a multi-pass aggregate (counts + at-risk + 12-month revenue +
 *      member-growth + under-delivered), NOT an SC-002 regression; in-region
 *      (sin1 ↔ ap-southeast-1) collapses to a few seconds. The ceiling here is a
 *      loose "does not blow the cron window" sanity bound, NOT a tight CP — set a
 *      strict in-region value via `PERF_DASHBOARD_COMPUTE_MS` on staging.
 *
 * The default read target IS the SC-002 CP (1500 ms); the cached read is so far
 * inside it that even local Bangkok→Neon-SG (~25 ms RTT) passes. Override the
 * read target for a strict in-region staging assertion via `PERF_DASHBOARD_P95_MS`.
 *
 * Gated by RUN_PERF=1. The numeric wall-clock CP (SC-002 full render) is
 * confirmed on staging in-region / via production RUM before flag-flip.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/insights/dashboard-perf.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  computeDashboardSnapshot,
  listDashboard,
  makeComputeDashboardSnapshotDeps,
  makeListDashboardDeps,
} from '@/modules/insights';
import { dashboardMetricsCache } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const RUN_PERF = process.env.RUN_PERF === '1';
const SEED_MEMBERS = 5_000;
const CHUNK = 500;
const RUN_COUNT = 20;
// Read target IS the SC-002 CP (1.5 s). The cached read is an O(1) PK lookup —
// the 1.5 s budget absorbs the ~25 ms Bangkok→SG RTT locally. Override for an
// explicit in-region (sin1 ↔ ap-southeast-1) staging assertion.
const READ_P95_TARGET_MS = Number(process.env.PERF_DASHBOARD_P95_MS ?? '1500');
// "Does not blow the cron window" sanity ceiling for the offline compute — NOT a
// tight CP. Local cross-region (~18 s @ 5k) is dominated by Bangkok→SG RTT on a
// multi-pass aggregate; in-region collapses to a few seconds. 60 s leaves a 5×
// margin under the */5 cron interval while still catching a pathological
// regression. Set a strict in-region value via `PERF_DASHBOARD_COMPUTE_MS`.
const COMPUTE_TARGET_MS = Number(process.env.PERF_DASHBOARD_COMPUTE_MS ?? '60000');

type Band = 'healthy' | 'warning' | 'at-risk' | 'critical' | null;
const BANDS: Band[] = ['healthy', 'healthy', 'warning', 'at-risk', 'critical', null];

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe.skipIf(!RUN_PERF)('dashboard perf @ 5k members (T098, RUN_PERF=1)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-perf-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Perf Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
    });

    // Bulk-insert 5k members in chunks (createMember per-row would be far too
    // slow). Mix risk bands so the at-risk aggregate + insights are realistic.
    for (let i = 0; i < SEED_MEMBERS; i += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, SEED_MEMBERS - i) }).map(
        (_, j) => {
          const band = BANDS[(i + j) % BANDS.length]!;
          return {
            tenantId: tenant.ctx.slug,
            memberId: randomUUID(),
            // 055-member-number — NOT NULL + per-tenant UNIQUE; `i + j` is the
            // 0-based global member index, so `+ 1` is collision-free 1..N.
            memberNumber: i + j + 1,
            companyName: `Perf Co ${i + j}`,
            country: 'TH',
            planId,
            planYear: 2026,
            status: 'active' as const,
            riskScore: band === null ? null : band === 'critical' ? 90 : 60,
            riskScoreBand: band,
          };
        },
      );
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values(batch);
      });
    }
  }, 300_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 180_000);

  it(`compute @ ${SEED_MEMBERS} members < ${COMPUTE_TARGET_MS}ms (cron cost, FR-005 freshness)`, async () => {
    const deps = makeComputeDashboardSnapshotDeps(tenant.ctx.slug);
    // Warm-up (also populates the cache for the read test below).
    await computeDashboardSnapshot(tenant.ctx, deps);

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await computeDashboardSnapshot(tenant.ctx, deps);
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.counts.total).toBe(SEED_MEMBERS);
      samples.push(t1 - t0);
    }
    const p95 = percentile(samples, 95);
    console.log(
      `  dashboard COMPUTE @ ${SEED_MEMBERS} members: p95=${p95.toFixed(0)}ms (target ${COMPUTE_TARGET_MS}ms)`,
    );
    expect(p95).toBeLessThan(COMPUTE_TARGET_MS);
  }, 120_000);

  it(`read (listDashboard) p95 < ${READ_P95_TARGET_MS}ms @ ${SEED_MEMBERS} members (SC-002 data path)`, async () => {
    const deps = makeListDashboardDeps(tenant.ctx.slug);
    const meta = {
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      requestId: `dash-perf-${randomUUID()}`,
    };
    // Warm-up — cache was populated by the compute test; this reads it.
    await listDashboard(meta, tenant.ctx, deps);

    const samples: number[] = [];
    for (let i = 0; i < RUN_COUNT; i++) {
      const t0 = performance.now();
      const r = await listDashboard(
        { ...meta, requestId: `dash-perf-${i}` },
        tenant.ctx,
        deps,
      );
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      samples.push(t1 - t0);
    }
    const p95 = percentile(samples, 95);
    const p50 = percentile(samples, 50);
    console.log(
      `  dashboard READ @ ${SEED_MEMBERS} members: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (target ${READ_P95_TARGET_MS}ms)`,
    );
    expect(p95).toBeLessThan(READ_P95_TARGET_MS);
  }, 60_000);
});
