/**
 * F8 Phase 10 · T262 — `dispatchRenewalCycle` cron perf benchmark
 * (RUN_PERF=1).
 *
 * Verifies FR-017 / SC-005 SLO: per-tenant cron pass MUST complete in
 * <60s @ 5,000 active members on live Neon ap-southeast-1. This bench
 * uses 1,000 cycles (PERF_MEMBER_COUNT default) and linearly extrapolates
 * to the 5k production scale per the at-risk-recompute precedent.
 *
 * The Resend gateway is stubbed so this measures F8's own dispatch loop
 * (candidate fetch → per-cycle decision → reminder_event insert → audit
 * emit) WITHOUT external email API latency (which is bounded by F1's own
 * SLO + retry budget). The stubbed `sendRenewalEmail` returns instantly,
 * so the measured cron duration is the worst-case F8 server-side time.
 *
 * Run:
 *   RUN_PERF=1 pnpm test:integration tests/integration/renewals/cron-dispatch-perf.test.ts
 *   RUN_PERF=1 PERF_MEMBER_COUNT=5000 PERF_SLO_STRICT=1 pnpm test:integration ...
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, type InferInsertModel } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const RUN_PERF = process.env.RUN_PERF === '1';
const MEMBER_COUNT = Number.parseInt(process.env.PERF_MEMBER_COUNT ?? '1000', 10);
const BATCH_SIZE = 250;
const PERF_SLO_MS = 60_000; // FR-017 / SC-005
const PERF_SLO_STRICT = process.env.PERF_SLO_STRICT === '1';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Pin clock so all seeded cycles fall within the T-30 step window.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const NOW_MS = new Date(NOW_ISO).getTime();
// All cycles expire 30 days from NOW so dispatcher selects T-30 step.
const EXPIRES_AT = new Date(NOW_MS + 30 * MS_PER_DAY);
const PERIOD_FROM = new Date(NOW_MS - 335 * MS_PER_DAY);

interface SeededCycle {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedBulkDispatchCandidates(
  tenant: TestTenant,
  user: TestUser,
  count: number,
): Promise<ReadonlyArray<SeededCycle>> {
  const planId = `f8-disp-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Perf Dispatch Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  const seeded: SeededCycle[] = [];
  for (let offset = 0; offset < count; offset += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, count - offset);
    const memberRows: Array<InferInsertModel<typeof members>> = [];
    const contactRows: Array<InferInsertModel<typeof contacts>> = [];
    const cycleRows: Array<InferInsertModel<typeof renewalCycles>> = [];
    for (let i = 0; i < batchSize; i++) {
      const idx = offset + i;
      const memberId = randomUUID();
      const cycleId = randomUUID();
      memberRows.push({
        tenantId: tenant.ctx.slug,
        memberId,
        // 055-member-number — NOT NULL + per-tenant UNIQUE; `idx` is the
        // 0-based global member index, so `idx + 1` is collision-free 1..N.
        memberNumber: idx + 1,
        companyName: `Perf Dispatch Co ${idx}`,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      contactRows.push({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Perf',
        lastName: `D${idx}`,
        email: `disp-${idx}-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en' as const,
      });
      cycleRows.push({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming' as const,
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
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

describe.skipIf(!RUN_PERF)(
  'F8 dispatchRenewalCycle perf — integration (T262, RUN_PERF=1)',
  () => {
    let tenant: TestTenant;
    let user: TestUser;
    let seeded: ReadonlyArray<SeededCycle>;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      await seedRenewalPolicies(tenant.ctx);
      const seedStart = Date.now();
      seeded = await seedBulkDispatchCandidates(tenant, user, MEMBER_COUNT);
      const seedDurationMs = Date.now() - seedStart;
      console.log(
        `[T262] Seeded ${seeded.length} dispatch candidates in ${seedDurationMs}ms`,
      );
    }, 600_000);

    afterAll(async () => {
      const memberIds = seeded.map((s) => s.memberId);
      for (let i = 0; i < memberIds.length; i += 1000) {
        const slice = memberIds.slice(i, i + 1000);
        await db
          .delete(renewalReminderEvents)
          .where(inArray(renewalReminderEvents.cycleId, seeded.slice(i, i + 1000).map((s) => s.cycleId)))
          .catch(() => {});
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

    it(`per-tenant cron pass <${PERF_SLO_MS}ms @ ${MEMBER_COUNT} members (strict=${PERF_SLO_STRICT})`, async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);
      // Stub gateway — bench measures F8 server-side dispatch loop, NOT
      // Resend latency. Real Resend SLA enforced by F1's own contract.
      const gatewaySpy = vi
        .spyOn(deps.renewalGateway, 'sendRenewalEmail')
        .mockResolvedValue({
          ok: true,
          value: {
            deliveryId: `mock-${randomUUID().slice(0, 8)}`,
            dispatchedAt: NOW_ISO,
          },
        } as never);

      const cronStart = performance.now();
      const result = await dispatchRenewalCycle(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: randomUUID(),
        nowIso: NOW_ISO,
        pageSize: 200,
      });
      const cronDurationMs = performance.now() - cronStart;
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.summary.candidatesProcessed).toBeGreaterThan(0);
      // R5-Q1 close: pin positive-path assertion. Without this, a
      // bench-seed regression (e.g. all candidates skip via Gate 6 on
      // members.email_unverified=true silently) would still pass the
      // perf test by measuring only early-exit branches. Mirrors the
      // T264 fix (commit 52637d75) for tier-upgrade-evaluate-perf.
      expect(result.value.summary.emailsSent).toBeGreaterThan(0);

      const perCandidateMs =
        cronDurationMs / Math.max(1, result.value.summary.candidatesProcessed);

      console.log(
        `[T262] candidates=${result.value.summary.candidatesProcessed} sent=${result.value.summary.emailsSent} cron=${cronDurationMs.toFixed(0)}ms (${perCandidateMs.toFixed(2)}ms/candidate)`,
      );

      try {
        appendFileSync(
          'perf-benchmarks.md',
          `\n## F8 Phase 10 T262 — dispatchRenewalCycle @ ${MEMBER_COUNT} cycles (${new Date().toISOString()})\n` +
            `- candidates: ${result.value.summary.candidatesProcessed}\n` +
            `- cron pass: ${cronDurationMs.toFixed(0)}ms (SLO ${PERF_SLO_MS}ms; strict=${PERF_SLO_STRICT})\n` +
            `- per-candidate avg: ${perCandidateMs.toFixed(2)}ms\n` +
            `- gateway: stubbed (measures F8 server-side; F1 Resend SLA separate)\n` +
            `- extrapolation to 5k: ~${((cronDurationMs / MEMBER_COUNT) * 5000).toFixed(0)}ms (linear)\n`,
        );
      } catch {
        // perf-benchmarks.md may not exist; non-fatal.
      }

      gatewaySpy.mockRestore();

      if (PERF_SLO_STRICT) {
        // Production-equivalent infra: assert against the 60s budget at
        // the bench's seeded scale, then linear-extrapolate to 5k in
        // the doc above. CI can override scale via PERF_MEMBER_COUNT.
        expect(cronDurationMs).toBeLessThan(PERF_SLO_MS);
      } else {
        expect(cronDurationMs).toBeGreaterThan(0);
      }
    }, 600_000);
  },
);
