/**
 * 063 residual · cross-VERSION catch-up double-send guard (live Neon).
 *
 * Bug (reliability re-review of e654feb8): the in-version 063 #1 fix made
 * the idempotency `year_in_cycle` STEP-anchored — derived from the step's
 * due-DAY at UTC midnight (`computeYearInCycle(periodFrom, stepDueDay)`).
 * For rows written by THIS code (on-time + catch-up) the dedup year always
 * matches → dedup works (covered by `cross-year-catchup-double-send.test.ts`).
 *
 * BUT a row written by the PRE-063 code stored
 * `year_in_cycle = computeYearInCycle(cycle.periodFrom, ctx.nowIso)` — the
 * cron RUN-INSTANT (with time-of-day), NOT the step's due-day midnight.
 * `period_from` is a `timestamptz` from a real paid-at instant (NOT
 * midnight). When the step's due-day is the SAME UTC day as a 365×N-day
 * boundary from `period_from`, AND the run-instant on that day is after the
 * `period_from` time-of-day, `floor((t - period_from)/day)` crosses the
 * 365-multiple — so the legacy stored year is `stepAnchoredYear + 1`.
 *
 * Concretely (this test):
 *   period_from = 2025-06-07T06:00Z  (non-midnight, real paid-at)
 *   T-7 due-day  = 2026-06-07T00:00Z (the 365-day boundary day)
 *     → step-anchored (midnight) year = 1   ← what 063 dedup computes
 *     → legacy run-instant (08:00) year = 2 ← what PRE-063 wrote
 *
 * On the catch-up pass the dispatcher builds `firedKeys` from the legacy
 * row as `t-7.email::2`, computes the step-anchored year `1`, checks
 * `firedKeys.has('t-7.email::1')` → MISS, and `insertIfAbsent` writes
 * `year_in_cycle = 1` (no unique conflict with the year-2 row) → a SECOND
 * pending row → the member gets a DUPLICATE reminder. A transient rollout
 * window, but a real duplicate email.
 *
 * Fix (tolerant dedup): when a step's due-day is boundary-adjacent (its
 * day-offset from `period_from`'s day is within 1 of a 365-multiple), treat
 * the step as already-fired if an existing row matches the step-anchored
 * year OR `stepAnchoredYear + 1` (the only legacy drift direction, since the
 * run-instant on the due-day is >= the due-day midnight, so the legacy day
 * count is monotonic non-decreasing → drift is 0 or +1, never -1). This does
 * NOT weaken the multi-year same-step-different-year distinction: a
 * legitimate year-(N+1) occurrence of the same step is ~365 days later in
 * due-date — outside this pass's 7-day catch-up window — so the dispatcher is
 * never trying to fire it on the same pass, and that future pass dedups
 * against its own exact-year row normally.
 *
 * RED proof against e654feb8: on the boundary day the dispatcher mints a
 * `year_in_cycle = 1` row + calls the gateway → `emailsSent === 1` and 2
 * reminder rows. The assertions below (`emailsSent === 0`, exactly 1 row,
 * gateway 0 calls) fail.
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
// real-now to be picked up. Anchor all dates on real-now's midnight (UTC).
//
//   expires_at  = today + 5d  (future → its own T+0 step is NOT yet due,
//                              so ONLY the T-7 step is in the window)
//   T-7 due-day = expires_at - 7d = today - 2d  (overdue by 2d, in window)
//   period_from = T-7 due-day - 365d + 6h  → the T-7 due-day is EXACTLY the
//                 365-day boundary day, with a NON-midnight (06:00) anchor:
//                   - step-anchored (midnight) year = 1
//                   - legacy run-instant (08:00) year = 2  (the drift)
//   cron run    = today midnight
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TODAY_UTC_MIDNIGHT_MS = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
const NOW_ISO = new Date(TODAY_UTC_MIDNIGHT_MS).toISOString();
const EXPIRES_AT = new Date(TODAY_UTC_MIDNIGHT_MS + 5 * MS_PER_DAY);
const T7_DUE_DAY_MS = EXPIRES_AT.getTime() - 7 * MS_PER_DAY; // today - 2d (midnight)
// period_from at 06:00 on the day exactly 365 days before the T-7 due-day,
// so the boundary lands inside the due-day.
const PERIOD_FROM = new Date(T7_DUE_DAY_MS - 365 * MS_PER_DAY + 6 * 3600 * 1000);
const STEP_ID = 't-7.email';
// Legacy on-time send ran on the T-7 due-day at 08:00 (> 06:00 period_from
// time-of-day → run-date year drifts to 2). This is what the PRE-063
// dispatcher persisted on the on-time reminder_event row.
const LEGACY_RUN_INSTANT = new Date(T7_DUE_DAY_MS + 8 * 3600 * 1000);
const LEGACY_STORED_YEAR = 2;

describe('063 residual · legacy run-date-year catch-up double-send guard — live Neon', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-legacyyear-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Legacy-year Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Legacy-year Co',
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
        email: `legacyyear-${randomUUID().slice(0, 6)}@acme.example`,
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
      // Seed the ORIGINAL on-time send as a `sent` reminder_event under the
      // LEGACY run-date year (2) — what the PRE-063 dispatcher wrote when it
      // fired the T-7 step on its exact due-day, using the run-INSTANT (with
      // time-of-day) year rather than the step-anchored midnight year. The
      // catch-up pass must recognise this as already-fired and NOT mint a
      // step-anchored-year (1) duplicate.
      await tx.insert(renewalReminderEvents).values({
        tenantId: tenantA.ctx.slug,
        reminderEventId: randomUUID(),
        cycleId,
        stepId: STEP_ID,
        channel: 'email',
        templateId: 'renewal.t-7.regular',
        status: 'sent',
        dispatchedAt: LEGACY_RUN_INSTANT,
        deliveryId: `seed-delivery-${randomUUID().slice(0, 8)}`,
        yearInCycle: LEGACY_STORED_YEAR,
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

  it('catch-up recognises a PRE-063 run-date-year row near the boundary (no duplicate row, no duplicate send)', async () => {
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

    // RED against e654feb8 (step-anchored-only dedup): the catch-up computes
    // step-anchored year 1, misses the legacy year-2 row in `firedKeys`, and
    // mints a fresh year-1 send → emailsSent === 1, 2 rows. The tolerant
    // dedup recognises the legacy year-2 row → idempotency hit → 0 sends.
    expect(r.value.summary.emailsSent).toBe(0);
    expect(r.value.summary.skipped.already_sent).toBe(1);
    // The gateway was NEVER called — no duplicate reminder reached the member.
    expect(gatewaySpy).not.toHaveBeenCalled();

    // Exactly ONE reminder_event row for the step — the seeded legacy row.
    // No step-anchored-year (1) duplicate was minted.
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
    expect(reminderRows[0]?.yearInCycle).toBe(LEGACY_STORED_YEAR);
    expect(reminderRows[0]?.status).toBe('sent');

    gatewaySpy.mockRestore();
  }, 120_000);
});
