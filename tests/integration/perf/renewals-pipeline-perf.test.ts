/**
 * F8 Phase 3 verify-run C1 — Renewal pipeline query perf (SC-003 / FR-046).
 *
 * Target: p95 < 500ms for `loadPipeline` first-page query at 5,000-active-
 * member × 2-tenant scale, with 600 cycles falling inside the 90-day
 * window (mix of urgency buckets t-90 through t-7).
 *
 * Mirrors F4 `invoice-list-perf.test.ts` (T110a) — same 5k×2 scale, same
 * RUN_PERF=1 gating so the heavy seed doesn't burn minutes on every CI
 * tick. Skip is observable.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/perf/renewals-pipeline-perf.test.ts
 *
 * Why 2 tenants in the seed: RLS + the implicit `tenant_id = ?` filter
 * (via `runInTenant` SET LOCAL) are BOTH expected to bound the candidate
 * rowset before the URGENCY CASE evaluation + ORDER BY. Seeding a second
 * 5,000-cycle tenant proves the pipeline_idx still bounds p95 when the
 * raw `renewal_cycles` table is 10,000 rows. A regression that drops the
 * tenant predicate would see scan cost double here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadPipeline, makeRenewalsDeps } from '@/modules/renewals';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const RUN_PERF = process.env.RUN_PERF === '1';


const P95_BUDGET_MS = 500; // SC-003 / FR-046
const MEMBERS_PER_TENANT = 5_000;
const IN_WINDOW_PER_TENANT = 600; // 90-day pipeline window
const WARMUP_SAMPLES = 10;
const MEASURED_SAMPLES = 50;

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil(p * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

const TIERS = [
  'thai_alumni',
  'start_up',
  'regular',
  'premium',
  'partnership',
] as const;

async function seedTenant(tenant: TestTenant, user: TestUser): Promise<void> {
  const planId = `perf-${randomUUID().slice(0, 8)}`;
  // Plan + 1 master member (cycles can share since active-cycle UNIQUE
  // is per (tenant, member) — but we want N distinct members so the
  // pipeline JOIN to members is realistic. Seed N members in batches.
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
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });

  // Pre-generate member ids to share between member + cycle inserts.
  const memberIds = Array.from({ length: MEMBERS_PER_TENANT }, () =>
    randomUUID(),
  );

  // Seed members in batches of 500.
  const memberBatchSize = 500;
  for (let offset = 0; offset < MEMBERS_PER_TENANT; offset += memberBatchSize) {
    const rows = memberIds
      .slice(offset, offset + memberBatchSize)
      .map((mid, i) => ({
        tenantId: tenant.ctx.slug,
        memberId: mid,
        companyName: `Perf Co ${offset + i + 1}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }));
    await runInTenant(tenant.ctx, (tx) => tx.insert(members).values(rows));
  }

  // Seed cycles: 600 in 90-day window, rest outside.
  const now = Date.now();
  const cycleBatchSize = 500;
  for (let offset = 0; offset < MEMBERS_PER_TENANT; offset += cycleBatchSize) {
    const rows = memberIds
      .slice(offset, offset + cycleBatchSize)
      .map((mid, i) => {
        const idx = offset + i;
        // First 600 fall within 90-day window; spread across urgency
        // buckets via varying days (5..89). Rest are >90 days out.
        const days =
          idx < IN_WINDOW_PER_TENANT
            ? Math.floor(Math.random() * 85) + 5 // 5..89 days
            : 120 + (idx % 200); // 120..319 days (outside window)
        const expiresAt = new Date(now + days * 86_400_000);
        return {
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId: mid,
          status: 'upcoming' as const,
          periodFrom: new Date(expiresAt.getTime() - 365 * 86_400_000),
          periodTo: expiresAt,
          expiresAt,
          cycleLengthMonths: 12,
          tierAtCycleStart: TIERS[idx % TIERS.length]!,
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        };
      });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values(rows),
    );
  }
}

describe.skipIf(!RUN_PERF)(
  'F8 renewal pipeline perf (SC-003 / FR-046 — RUN_PERF=1)',
  () => {
    let tenantA: TestTenant;
    let tenantB: TestTenant;
    let user: TestUser;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenantA = await createTestTenant('test-swecham');
      tenantB = await createTestTenant('test-chamber');
      // Sequential seed (parallel tx writers compete for the per-tenant
      // RLS GUC; sequential is faster + deterministic for the seed).
      await seedTenant(tenantA, user);
      await seedTenant(tenantB, user);
    }, 600_000); // 10 min cap for the 5k×2 seed

    afterAll(async () => {
      for (const t of [tenantA, tenantB]) {
        await db
          .delete(renewalCycles)
          .where(eq(renewalCycles.tenantId, t.ctx.slug))
          .catch(() => {});
      }
      await tenantA.cleanup().catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }, 300_000);

    it(
      `loadPipeline first-page p95 < ${P95_BUDGET_MS}ms @ 5k members + 600 in window`,
      async () => {
        const deps = makeRenewalsDeps(tenantA.ctx.slug);

        // Warmup runs — let the postgres connection pool + plan cache
        // settle so the measured samples reflect steady-state perf.
        for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
          await loadPipeline(deps, {
            tenantId: tenantA.ctx.slug,
            urgency: 't-30',
            limit: 50,
          });
        }

        const samples: number[] = [];
        for (let i = 0; i < MEASURED_SAMPLES; i += 1) {
          const start = performance.now();
          const result = await loadPipeline(deps, {
            tenantId: tenantA.ctx.slug,
            urgency: 't-30',
            limit: 50,
          });
          const elapsed = performance.now() - start;
          if (!result.ok) {
            throw new Error(
              `loadPipeline returned err in perf run: ${result.error.kind}`,
            );
          }
          samples.push(elapsed);
        }

        const sorted = [...samples].sort((a, b) => a - b);
        const p50 = percentile(sorted, 0.5);
        const p95 = percentile(sorted, 0.95);
        const p99 = percentile(sorted, 0.99);

        // Surface the timings so CI logs carry the evidence even on PASS.
        console.log(
          `[F8 pipeline perf] p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms (n=${MEASURED_SAMPLES})`,
        );

        expect(p95).toBeLessThan(P95_BUDGET_MS);
      },
      300_000,
    );

    it(
      'cross-tenant: tenant B query stays within budget too (RLS overhead)',
      async () => {
        const deps = makeRenewalsDeps(tenantB.ctx.slug);
        for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
          await loadPipeline(deps, {
            tenantId: tenantB.ctx.slug,
            urgency: 't-30',
            limit: 50,
          });
        }
        const samples: number[] = [];
        for (let i = 0; i < MEASURED_SAMPLES; i += 1) {
          const start = performance.now();
          await loadPipeline(deps, {
            tenantId: tenantB.ctx.slug,
            urgency: 't-30',
            limit: 50,
          });
          samples.push(performance.now() - start);
        }
        const p95 = percentile(
          [...samples].sort((a, b) => a - b),
          0.95,
        );
        console.log(`[F8 pipeline perf · tenant B] p95=${p95.toFixed(0)}ms`);
        expect(p95).toBeLessThan(P95_BUDGET_MS);
      },
      300_000,
    );
  },
);
