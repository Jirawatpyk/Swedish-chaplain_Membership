/**
 * 063 residual · cross-VERSION dedup × #4-perf-gate INTERACTION double-send
 * guard, on the TODAY-EXACTLY (non-overdue) path (live Neon).
 *
 * Two prior 063 round-2 fixes interact badly on this exact path:
 *
 *   - e654feb8 (#4 perf): the per-cycle history read (`listForCycle`, which
 *     populates `firedKeys`) is gated behind `hasOverdueStep` — it is only
 *     read when at least one window step is OVERDUE (`stepDueDay < todayUtc`).
 *     On the common today-exactly path (step due EXACTLY today, nothing
 *     overdue) the read is SKIPPED and the Gate-12 unique index is relied on
 *     as the sole dedup guard. `firedKeys` stays EMPTY.
 *
 *   - 41a8a759 (cross-VERSION tolerance): a step counts as already-fired when
 *     an existing row matches the step-anchored year OR — only for a
 *     boundary-adjacent step — `stepAnchoredYear + 1` (the PRE-063 legacy
 *     run-instant drift). This tolerance reads `firedKeys`.
 *
 * The interaction: on the today-exactly path `firedKeys` is EMPTY (the read
 * was gated off), so the `+1` tolerance in `firedKeyForStep` is INERT — it can
 * never match because there is nothing in the set. A PRE-063 legacy on-time
 * row stored at the run-date year `stepAnchoredYear + 1` (boundary-adjacent,
 * non-midnight `period_from`) is therefore NOT recognised. Gate-12
 * `insertIfAbsent` runs at the step-anchored year `N` and does NOT collide
 * with the legacy `(cycle, step, N+1)` row → `created = true` → a SECOND
 * reminder email is dispatched. Window: a boundary-adjacent step (~0.5% of
 * step-days) + the deploy day + a same-UTC-day cron re-run after the pre-063
 * on-time send.
 *
 * The sibling cross-year test (`cross-year-catchup-double-send.test.ts`) and
 * the overdue cross-version test (`legacy-rundate-year-catchup-double-send.
 * test.ts`) both put the step OVERDUE (`expires_at = today + 5d`, so the T-7
 * step is `today - 2d`), which forces `hasOverdueStep = true` → `firedKeys` IS
 * populated → the tolerance works. They do NOT exercise the today-exactly path,
 * where the gate skips the read. This test is the regression guard for that
 * #4 × tolerance interaction.
 *
 * Concretely (this test, thai_alumni tier, T-3 step):
 *   period_from = (today - 365d) + 6h  (non-midnight, real paid-at)
 *   expires_at  = today + 3d
 *   T-3 due-day = expires_at - 3d = today  (due EXACTLY today → NOT overdue →
 *                 hasOverdueStep === false → listForCycle SKIPPED → firedKeys
 *                 empty without the fix)
 *     → due-day offset from period_from's day = 365 → boundary-adjacent
 *     → step-anchored (midnight) year = 1   ← what the dedup computes
 *     → legacy run-instant (08:00) year = 2 ← what PRE-063 wrote on-time
 *   Other thai_alumni steps (t-30 → today-27, t-14 → today-11, t+7 →
 *   today+10) all fall OUTSIDE the 7-day catch-up window, so the T-3 step is
 *   the ONLY in-window step and there is genuinely no overdue step.
 *
 * RED proof against e654feb8 + 41a8a759 (today-exactly skips listForCycle →
 * the +1 tolerance is inert → no recognition of the legacy year-2 row): the
 * dispatcher mints a `year_in_cycle = 1` row + calls the gateway →
 * `emailsSent === 1` and 2 reminder rows. The assertions below
 * (`emailsSent === 0`, exactly 1 row, gateway 0 calls) fail.
 *
 * Fix (read `firedKeys` on boundary-adjacent today-exactly steps too):
 *   needsFiredKeys = hasOverdueStep || windowSteps.some(boundaryAdjacent)
 * so the tolerance is no longer inert on this path. The extra read only fires
 * on the rare boundary-adjacent days (~0.5% of step-days), preserving the #4
 * perf win for the common today-exactly case.
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

// Anchor all dates on real-now's UTC midnight so the day-floored year
// arithmetic is exact (no time-of-day fraction in the run-clock).
//
//   expires_at  = today + 3d  (future → its own T+0/T+7 steps NOT yet due)
//   T-3 due-day = expires_at - 3d = today  (due EXACTLY today → NOT overdue)
//   period_from = (today - 365d) + 6h  → the T-3 due-day (= today) is EXACTLY
//                 the 365-day boundary day, with a NON-midnight (06:00) anchor:
//                   - step-anchored (midnight) year = 1
//                   - legacy run-instant (08:00) year = 2  (the +1 drift)
//   cron run    = today midnight  (the deploy-day re-run after the on-time send)
//
// thai_alumni tier is chosen because its T-3 step (offset -3) has NO sibling
// step inside the 7-day catch-up window when due today: t-30 → today-27,
// t-14 → today-11 (both stale beyond the lookback), t+7 → today+10 (future).
// So the T-3 step is the ONLY in-window step and hasOverdueStep is genuinely
// false — exercising the today-exactly path the existing guards miss.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TODAY_UTC_MIDNIGHT_MS = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
const NOW_ISO = new Date(TODAY_UTC_MIDNIGHT_MS).toISOString();
const EXPIRES_AT = new Date(TODAY_UTC_MIDNIGHT_MS + 3 * MS_PER_DAY);
const T3_DUE_DAY_MS = EXPIRES_AT.getTime() - 3 * MS_PER_DAY; // today (midnight)
// period_from at 06:00 on the day exactly 365 days before the T-3 due-day,
// so the 365-day boundary lands inside the due-day (boundary-adjacent),
// with a non-midnight time-of-day so the legacy run-instant year drifts +1.
const PERIOD_FROM = new Date(T3_DUE_DAY_MS - 365 * MS_PER_DAY + 6 * 3600 * 1000);
const STEP_ID = 't-3.email';
// Legacy on-time send ran on the T-3 due-day (= today) at 08:00 (> 06:00
// period_from time-of-day → run-date year drifts 1 → 2). This is what the
// PRE-063 dispatcher persisted on the on-time reminder_event row.
const LEGACY_RUN_INSTANT = new Date(T3_DUE_DAY_MS + 8 * 3600 * 1000);
const LEGACY_STORED_YEAR = 2;

describe('063 residual · legacy run-date-year today-exactly double-send guard — live Neon', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-todayexact-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Today-exactly Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Today-exactly Co',
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
        email: `todayexact-${randomUUID().slice(0, 6)}@acme.example`,
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
        // thai_alumni so the T-3 step has no in-window sibling (see header).
        tierAtCycleStart: 'thai_alumni',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      // Seed the ORIGINAL on-time send as a `sent` reminder_event under the
      // LEGACY run-date year (2) — what the PRE-063 dispatcher wrote when it
      // fired the T-3 step on its exact due-day (= today), using the
      // run-INSTANT (with time-of-day) year rather than the step-anchored
      // midnight year. The today-exactly catch-up re-run must recognise this
      // as already-fired and NOT mint a step-anchored-year (1) duplicate.
      await tx.insert(renewalReminderEvents).values({
        tenantId: tenantA.ctx.slug,
        reminderEventId: randomUUID(),
        cycleId,
        stepId: STEP_ID,
        channel: 'email',
        templateId: 'renewal.t-3.thai_alumni',
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

  it('today-exactly boundary-adjacent re-run recognises a PRE-063 run-date-year row (no duplicate row, no duplicate send)', async () => {
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

    // RED against e654feb8 + 41a8a759 (today-exactly skips listForCycle → the
    // +1 tolerance is inert → the legacy year-2 row is unseen → a fresh
    // year-1 send is minted): emailsSent === 1, 2 rows. With firedKeys read on
    // a boundary-adjacent today-exactly step, the tolerant dedup recognises
    // the legacy year-2 row → idempotency hit → 0 sends.
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
