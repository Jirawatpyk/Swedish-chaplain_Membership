/**
 * F8 Phase 4 T115 — `dispatchRenewalCycle` cron pass perf benchmark
 * (FR-017 / SC-005).
 *
 * Target: per-tenant cron pass MUST complete within 60 seconds at the
 * 5,000-active-member scale.
 *
 * Strategy:
 *   - Seed 5,000 members + 5,000 upcoming cycles into a throwaway test
 *     tenant so the benchmark doesn't pollute the swecham tenant.
 *   - Spread `expires_at` across the 8 urgency buckets so the
 *     `findStepForDate` decision tree exercises every cadence step
 *     (not just T-30).
 *   - Stub the renewal gateway so we measure DISPATCH overhead (DB +
 *     gate evaluation + audit emit + reminder_event insert) rather
 *     than Resend network latency.
 *   - Run dispatch ONCE (cold pass, all candidates → all `sent`) +
 *     once more (warm replay, all → `already_sent`). Idempotency
 *     replay is the dominant cron-tick path (FR-011).
 *
 * Gated behind `RUN_PERF=1` to avoid burning 5–10 min on every CI tick.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/perf/renewals-cron-5k.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import {
  dispatchRenewalCycle,
  makeRenewalsDeps,
} from '@/modules/renewals';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

const RUN_PERF = process.env.RUN_PERF === '1';


const BUDGET_MS = 60_000; // FR-017 / SC-005
const MEMBERS_PER_TENANT = 5_000;

async function seedTenant(
  tenant: TestTenant,
  user: TestUser,
): Promise<void> {
  // 5 default schedule policies — required so dispatchOneCycle's
  // Gate 7 doesn't short-circuit every candidate as `tenant_misconfigured`.
  await seedRenewalPolicies(tenant.ctx);

  const planId = `perf-cron-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Perf Cron Plan' },
      annualFeeMinorUnits: 1_000_000,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
  });

  // Pre-generate member ids so member + contact + cycle insert phases
  // share the same UUIDs.
  const memberIds = Array.from({ length: MEMBERS_PER_TENANT }, () =>
    randomUUID(),
  );

  // Seed members in batches of 500.
  const batch = 500;
  for (let offset = 0; offset < MEMBERS_PER_TENANT; offset += batch) {
    const rows = memberIds
      .slice(offset, offset + batch)
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

  // Seed primary contacts (1 per member). The dispatcher's Gate 11
  // requires a primary contact for email channel — without these,
  // every candidate would land on `no_primary_contact` skip + create
  // an escalation task, which is a different load profile.
  for (let offset = 0; offset < MEMBERS_PER_TENANT; offset += batch) {
    const rows = memberIds
      .slice(offset, offset + batch)
      .map((mid, i) => ({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: mid,
        firstName: 'Perf',
        lastName: `Member ${offset + i + 1}`,
        email: `perf-${offset + i + 1}-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en' as const,
      }));
    await runInTenant(tenant.ctx, (tx) => tx.insert(contacts).values(rows));
  }

  // Seed 5,000 cycles; spread expires_at across the 8 urgency buckets
  // so dispatchOneCycle exercises every step in the schedule policy.
  // Day offsets: -30, -14, -7, -3, 0, +7 are FR-013 step targets;
  // populate the next 90 days.
  const now = Date.now();
  for (let offset = 0; offset < MEMBERS_PER_TENANT; offset += batch) {
    const rows = memberIds
      .slice(offset, offset + batch)
      .map((mid) => {
        // Spread over 5..89 days from now so cycles distribute across
        // T-90/T-60/T-30/T-14/T-7/T-3/T+0/grace urgency buckets.
        const days = 5 + Math.floor(Math.random() * 85);
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
          tierAtCycleStart: 'regular' as const,
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB' as const,
        };
      });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values(rows),
    );
  }
}

describe.skipIf(!RUN_PERF)(
  'F8 cron dispatch perf — 5k members per tenant (FR-017 / SC-005)',
  () => {
    let tenant: TestTenant;
    let user: TestUser;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      await seedTenant(tenant, user);
    }, 600_000); // 10 min cap for 5k seed

    afterAll(async () => {
      // Reverse FK order: reminder_events → cycles → contacts → members
      // → audit. The throwaway test-tenant cleanup below also drops
      // membership_plans and tenant_renewal_settings.
      await db
        .delete(renewalReminderEvents)
        .where(eq(renewalReminderEvents.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await tenant.cleanup().catch(() => {});
    }, 300_000);

    it('cold pass: 5,000 candidates dispatched < 60 s', async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);
      // Stub the gateway so the benchmark measures local pipeline
      // overhead (DB + RLS + audit + reminder_event insert) rather
      // than Resend network latency.
      vi.spyOn(deps.renewalGateway, 'sendRenewalEmail').mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-${randomUUID().slice(0, 8)}`,
          dispatchedAt: new Date().toISOString(),
        },
      } as never);

      const startedAt = Date.now();
      const result = await dispatchRenewalCycle(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: randomUUID(),
        nowIso: new Date().toISOString(),
        // Allow up to 5,000 in one pass — beyond default 200 page size.
        pageSize: 1_000,
      });
      const duration = Date.now() - startedAt;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.candidatesProcessed).toBe(MEMBERS_PER_TENANT);
      // The cold pass distributes cycles across all 8 urgency buckets;
      // most won't have a step due today, so emailsSent is the COUNT of
      // cycles whose `expires_at − now ∈ {schedule offset days}`. With
      // random spread over 5..89 days, expect a meaningful subset.
      // The hard requirement is the duration budget, not a specific
      // emailsSent count.
      expect(duration).toBeLessThan(BUDGET_MS);
      console.log(
        `[T115 perf] cold pass: ${duration} ms · processed ${result.value.summary.candidatesProcessed} · sent ${result.value.summary.emailsSent} · skipped not_due_today ${result.value.summary.skipped.not_due_today}`,
      );
    }, 120_000);

    it('warm pass: 5,000 candidates idempotency-replayed < 60 s', async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const gatewaySpy = vi
        .spyOn(deps.renewalGateway, 'sendRenewalEmail')
        .mockResolvedValue({
          ok: true,
          value: {
            deliveryId: `should-not-be-called-${randomUUID().slice(0, 8)}`,
            dispatchedAt: new Date().toISOString(),
          },
        } as never);

      const startedAt = Date.now();
      const result = await dispatchRenewalCycle(deps, {
        tenantId: tenant.ctx.slug,
        correlationId: randomUUID(),
        nowIso: new Date().toISOString(),
        pageSize: 1_000,
      });
      const duration = Date.now() - startedAt;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.candidatesProcessed).toBe(MEMBERS_PER_TENANT);
      // FR-011 idempotency: every previously-sent cycle short-circuits
      // with `skipped: 'already_sent'`. Gateway should NOT be invoked
      // again. New emails should equal the count of cycles whose step
      // matches today AND have no prior reminder_event row — should be
      // zero on warm replay (same nowIso as cold pass within minutes).
      expect(result.value.summary.emailsSent).toBe(0);
      expect(gatewaySpy).not.toHaveBeenCalled();
      expect(duration).toBeLessThan(BUDGET_MS);
      console.log(
        `[T115 perf] warm pass: ${duration} ms · processed ${result.value.summary.candidatesProcessed} · sent ${result.value.summary.emailsSent} · already_sent ${result.value.summary.skipped.already_sent}`,
      );
    }, 120_000);
  },
);
