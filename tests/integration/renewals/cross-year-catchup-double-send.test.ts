/**
 * 063 #1 · cross-quota-year catch-up double-send guard (live Neon).
 *
 * Bug (xhigh review): the dispatcher's idempotency namespace
 * (`firedKeys` dedup + Gate-12 `insertIfAbsent` `year_in_cycle`) was
 * computed from `computeYearInCycle(cycle.periodFrom, ctx.nowIso)` — the
 * cron RUN-date. The unique index is `(tenant, cycle, step_id,
 * year_in_cycle)`. For a CATCH-UP step whose DUE-date fell in the PRIOR
 * quota year (the 365-day boundary lands inside the 7-day catch-up
 * lookback), the run-date `year_in_cycle` drifts 1 → 2:
 *   - the original on-time send's row has `year_in_cycle = 1`
 *   - the catch-up pass checks `firedKeys` under `::2` (MISS) AND
 *     `insertIfAbsent` writes `year_in_cycle = 2` (no unique conflict)
 *   → a SECOND pending row → the member gets a DUPLICATE reminder.
 *
 * Fix: anchor the idempotency `year_in_cycle` on the step's DUE-date
 * (`computeYearInCycle(periodFrom, stepDueDate)`), so the catch-up pass
 * resolves the step to the SAME year (1) the original send recorded.
 *
 * Test scope:
 *   1. Seed a 12-month cycle whose T-7 step's due-date is 358 days into
 *      the cycle (quota year 1), and seed the ON-TIME `sent`
 *      reminder_event row under `year_in_cycle = 1` (simulating the
 *      original send). Run the dispatcher on the 365-day-boundary day
 *      (the run-date `computeYearInCycle` resolves to YEAR 2) which is
 *      exactly 7 days after the due-date (inside the lookback).
 *      → ZERO new reminder_event rows (still exactly 1, the seeded one)
 *      → ZERO gateway sends (no duplicate email)
 *      → the dispatcher reports `already_sent` (idempotency hit), NOT a
 *        fresh send under a drifted year.
 *
 * RED proof against the run-date-anchored code: on the boundary day the
 * dispatcher mints a `year_in_cycle = 2` row + calls the gateway →
 * `emailsSent === 1` and 2 reminder rows. The assertions below
 * (`emailsSent === 0`, exactly 1 row, gateway 0 calls) fail.
 *
 * Tenant isolation: insertion + reads scoped via `runInTenant(tenantA)`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// The dispatch-candidate repo filters cycles by `expires_at >= NOW() -
// maxOffsetDays` using the DB wall-clock, so `expires_at` must be near
// real-now to be picked up. Anchor all dates on real-now:
//
//   expires_at  = real-now + 2d  (in the candidate window)
//   period_from = expires_at - 365d  (exactly the 365-day boundary)
//   T-7 due     = expires_at - 7d  (358 days into the cycle → YEAR 1)
//   cron run    = expires_at (= period_from + 365d → run-date YEAR 2)
//                 → run-date - due-date = 7d → inside the 7-day lookback.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REAL_NOW_MS = Date.now();
const EXPIRES_AT = new Date(REAL_NOW_MS + 2 * MS_PER_DAY);
const PERIOD_FROM = new Date(EXPIRES_AT.getTime() - 365 * MS_PER_DAY);
const NOW_ISO = EXPIRES_AT.toISOString();
const STEP_ID = 't-7.email';
const ON_TIME_DISPATCHED_AT = new Date(
  EXPIRES_AT.getTime() - 7 * MS_PER_DAY,
).toISOString();

describe('063 #1 cross-year catch-up double-send guard — live Neon', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-xyear-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Cross-year Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Cross-year Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Anna',
        lastName: 'Adm',
        email: `xyear-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
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
      // Seed the ORIGINAL on-time send as a `sent` reminder_event under
      // year_in_cycle=1 (what the dispatcher wrote when it fired the T-7
      // step on its exact due-day 2025-12-25). The catch-up pass must
      // treat this as already-fired and NOT mint a year-2 duplicate.
      await tx.insert(renewalReminderEvents).values({
        tenantId: tenantA.ctx.slug,
        reminderEventId: randomUUID(),
        cycleId,
        stepId: STEP_ID,
        channel: 'email',
        templateId: 'renewal.t-7.regular',
        status: 'sent',
        dispatchedAt: new Date(ON_TIME_DISPATCHED_AT),
        deliveryId: `seed-delivery-${randomUUID().slice(0, 8)}`,
        yearInCycle: 1,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('catch-up on the 365-day boundary does NOT re-fire the prior-year step (no duplicate row, no duplicate send)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-delivery-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    const r = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // RED against the run-date-anchored year: this was 1 (a fresh send
    // under year_in_cycle=2). Step-anchored year resolves to year 1 →
    // idempotency hit → 0 sends.
    expect(r.value.summary.emailsSent).toBe(0);
    expect(r.value.summary.skipped.already_sent).toBe(1);
    // The gateway was NEVER called — no duplicate reminder reached the member.
    expect(gatewaySpy).not.toHaveBeenCalled();

    // Exactly ONE reminder_event row for the step — the seeded year-1 row.
    // No year-2 duplicate was minted.
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRows).toHaveLength(1);
    expect(reminderRows[0]?.stepId).toBe(STEP_ID);
    expect(reminderRows[0]?.yearInCycle).toBe(1);
    expect(reminderRows[0]?.status).toBe('sent');

    gatewaySpy.mockRestore();
  }, 120_000);
});
