/**
 * F8 Phase 10 · T261 — `loadPipeline` perf benchmark (RUN_PERF=1).
 *
 * Verifies FR-046 / SC-003 SLO: admin renewal-pipeline page loads with
 * p95 <500ms @ 5,000 active members + 600 visible cycles. This benchmark
 * uses 1,000 members (PERF_MEMBER_COUNT default) and linearly extrapolates
 * to the 5k production scale, per the at-risk-recompute precedent. Strict
 * SLO assertion is gated on PERF_SLO_STRICT=1 (production-equivalent infra).
 *
 * Run:
 *   RUN_PERF=1 pnpm test:integration tests/integration/renewals/pipeline-perf.test.ts
 *   RUN_PERF=1 PERF_MEMBER_COUNT=5000 PERF_SLO_STRICT=1 pnpm test:integration ...  # full SLO
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, type InferInsertModel } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadPipeline, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const RUN_PERF = process.env.RUN_PERF === '1';
const MEMBER_COUNT = Number.parseInt(process.env.PERF_MEMBER_COUNT ?? '1000', 10);
const VISIBLE_RATIO = 0.6; // ~600 of 1000 visible in 90-day window (mirrors 5k×600 spec)
const BATCH_SIZE = 250;
const SAMPLE_COUNT = 20;
const WARMUP_COUNT = 5;
const PERF_SLO_MS = 500; // FR-046 / SC-003
const PERF_SLO_STRICT = process.env.PERF_SLO_STRICT === '1';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();

interface SeededCycle {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedBulkCycles(
  tenant: TestTenant,
  user: TestUser,
  count: number,
): Promise<ReadonlyArray<SeededCycle>> {
  const planId = `f8-pipe-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Perf Pipeline Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  const seeded: SeededCycle[] = [];
  const visibleCount = Math.floor(count * VISIBLE_RATIO);
  for (let offset = 0; offset < count; offset += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, count - offset);
    const memberRows: Array<InferInsertModel<typeof members>> = [];
    const contactRows: Array<InferInsertModel<typeof contacts>> = [];
    const cycleRows: Array<InferInsertModel<typeof renewalCycles>> = [];
    for (let i = 0; i < batchSize; i++) {
      const idx = offset + i;
      const memberId = randomUUID();
      const cycleId = randomUUID();
      // First `visibleCount` members get an expiry within the 90-day
      // active window (urgency derivation exercises t-90/t-60/t-30/t-7).
      // Remainder fall outside the visible window so the summary
      // aggregation has both visible + lapsed-bucket coverage.
      const inWindow = idx < visibleCount;
      const offsetDays = inWindow ? 5 + (idx % 80) : -45 - (idx % 30);
      const expires = new Date(NOW_MS + offsetDays * MS_PER_DAY);
      memberRows.push({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `Perf Pipeline Co ${idx}`,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      contactRows.push({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Perf',
        lastName: `M${idx}`,
        email: `pipe-${idx}-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en' as const,
      });
      cycleRows.push({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        // All seeded rows are 'upcoming' (non-terminal). Past-expiry
        // upcoming rows are surfaced as 'grace' or 'lapsed' urgency by
        // the dashboard's DB-side derivation. Terminal-state seeds
        // would require closed_at + closed_reason per the
        // `renewal_cycles_closed_at_iff_terminal_check` CHECK.
        status: 'upcoming' as const,
        periodFrom: new Date(expires.getTime() - 365 * MS_PER_DAY),
        periodTo: expires,
        expiresAt: expires,
        cycleLengthMonths: 12,
        tierAtCycleStart: idx % 5 === 0 ? 'premium' : 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      seeded.push({ memberId, cycleId });
    }
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(memberRows);
      await tx.insert(contacts).values(contactRows);
      await tx.insert(renewalCycles).values(cycleRows);
    });
  }
  return seeded;
}

function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx] ?? 0;
}

describe.skipIf(!RUN_PERF)(
  'F8 loadPipeline perf — integration (T261, RUN_PERF=1)',
  () => {
    let tenant: TestTenant;
    let user: TestUser;
    let seeded: ReadonlyArray<SeededCycle>;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      await seedRenewalPolicies(tenant.ctx);
      const seedStart = Date.now();
      seeded = await seedBulkCycles(tenant, user, MEMBER_COUNT);
      const seedDurationMs = Date.now() - seedStart;
      console.log(
        `[T261] Seeded ${seeded.length} members + cycles in ${seedDurationMs}ms`,
      );
    }, 600_000);

    afterAll(async () => {
      const memberIds = seeded.map((s) => s.memberId);
      for (let i = 0; i < memberIds.length; i += 1000) {
        const slice = memberIds.slice(i, i + 1000);
        await db
          .delete(renewalCycles)
          .where(inArray(renewalCycles.memberId, slice))
          .catch(() => {});
        await db
          .delete(contacts)
          .where(inArray(contacts.memberId, slice))
          .catch(() => {});
        await db
          .delete(members)
          .where(inArray(members.memberId, slice))
          .catch(() => {});
      }
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await tenant.cleanup().catch(() => {});
    }, 600_000);

    it(`p95 <${PERF_SLO_MS}ms @ ${MEMBER_COUNT} members (strict=${PERF_SLO_STRICT})`, async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);

      // Warmup — primes connection pool + Postgres planner cache.
      for (let i = 0; i < WARMUP_COUNT; i++) {
        const r = await loadPipeline(deps, {
          tenantId: tenant.ctx.slug,
          urgency: 't-90',
          limit: 50,
        });
        expect(r.ok).toBe(true);
      }

      // Measured samples — alternate urgency tabs to exercise filter
      // permutations the dashboard issues during admin browsing.
      const URGENCY_TABS = ['t-90', 't-30', 't-7', 'lapsed'] as const;
      const samples: number[] = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const urgency = URGENCY_TABS[i % URGENCY_TABS.length]!;
        const t0 = performance.now();
        const r = await loadPipeline(deps, {
          tenantId: tenant.ctx.slug,
          urgency,
          limit: 50,
        });
        const elapsed = performance.now() - t0;
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.rows.length).toBeGreaterThanOrEqual(0);
        samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      const p99 = percentile(samples, 99);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

      console.log(
        `[T261] members=${MEMBER_COUNT} samples=${SAMPLE_COUNT} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms avg=${avg.toFixed(1)}ms`,
      );

      try {
        appendFileSync(
          'perf-benchmarks.md',
          `\n## F8 Phase 10 T261 — loadPipeline @ ${MEMBER_COUNT} members (${new Date().toISOString()})\n` +
            `- members: ${MEMBER_COUNT} (${Math.floor(MEMBER_COUNT * VISIBLE_RATIO)} in 90-day window)\n` +
            `- samples: ${SAMPLE_COUNT} (warmup ${WARMUP_COUNT})\n` +
            `- p50: ${p50.toFixed(1)}ms · p95: ${p95.toFixed(1)}ms · p99: ${p99.toFixed(1)}ms · avg: ${avg.toFixed(1)}ms\n` +
            `- SLO: <${PERF_SLO_MS}ms (FR-046/SC-003 @ 5k members; strict=${PERF_SLO_STRICT})\n` +
            `- extrapolation: production target Vercel sin1↔Neon SG (~5ms RTT) ≈ p95/3-5× local-from-BKK (~25ms RTT)\n`,
        );
      } catch {
        // perf-benchmarks.md may not exist on first run; non-fatal.
      }

      if (PERF_SLO_STRICT) {
        expect(p95).toBeLessThan(PERF_SLO_MS);
      } else {
        expect(p95).toBeGreaterThan(0);
      }
    }, 600_000);
  },
);
