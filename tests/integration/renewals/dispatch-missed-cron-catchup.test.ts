/**
 * 063 · `dispatchRenewalCycle` bounded missed-cron catch-up (live Neon).
 *
 * Bug: the dispatcher resolved the due step by STRICT day-equality
 * (`target === todayUtc`). If the daily cron did NOT run on the exact UTC
 * day a step was due (Vercel reboot / READ_ONLY_MODE window / infra
 * outage), the step's due-day passed and `target < todayUtc` forever → the
 * reminder was NEVER sent (silent drop). spec.md:194 + FR-010 require a
 * bounded catch-up.
 *
 * Test scope (matches the admin reactivation-ladder catch-up pattern):
 *   1. Seed a Regular-tier cycle whose T-7 step fell on a SKIPPED day
 *      (cron did not run that day). Run the dispatcher on a LATER day still
 *      inside the 7-day lookback window.
 *      → exactly 1 reminder_event row (status sent) for the T-7 step
 *      → exactly 1 `renewal_reminder_sent` audit carrying `caught_up: true`
 *        + `step_due_date` = the original (past) due-date
 *      → gateway saw exactly 1 send.
 *   2. Re-run on the same later day → ZERO new reminder_events, ZERO new
 *      audits, ZERO new gateway calls (idempotency holds for the catch-up).
 *
 * RED proof against the pre-063 strict-equality code: on day N+2 the T-7
 * step's `target` (= N) is strictly < todayUtc (= N+2), so `findStepForDate`
 * returned null → `not_due_today` → ZERO sends. The assertions below
 * (emailsSent === 1, caught_up === true) fail against that code.
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

// Regular-tier T-7 step: expires_at = today + 7 means the T-7 step is due
// TODAY. We instead make T-7 due 2 days in the PAST so the dispatcher must
// catch up: expires_at = (now + 7) - 2 = now + 5.
//   now (dispatcher clock) = today midnight UTC
//   T-7 due-date          = expires_at - 7 = today - 2  (2 days ago)
//   → strictly past, but within the 7-day lookback → catch up.
//
// Dates are anchored on the REAL wall-clock so the test never becomes stale:
// the dispatch-candidate repo filters `expires_at >= NOW() - maxOffsetDays`
// using the DB wall-clock (NOT the injected nowIso), so hardcoded future dates
// silently stop matching once DB_NOW > EXPIRES_AT + DEFAULT_MAX_OFFSET_DAYS.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TODAY_UTC_MIDNIGHT_MS = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
const EXPIRES_AT = new Date(TODAY_UTC_MIDNIGHT_MS + 5 * MS_PER_DAY); // today + 5d
const NOW_ISO = new Date(TODAY_UTC_MIDNIGHT_MS).toISOString(); // today midnight
// period_from 1y before expiry → year_in_cycle resolves to 1.
const PERIOD_FROM = new Date(EXPIRES_AT.getTime() - 365 * MS_PER_DAY);
// T-7 due-date = today - 2d (2 days overdue, inside the 7-day lookback).
const EXPECTED_DUE_DATE_ISO = new Date(
  EXPIRES_AT.getTime() - 7 * MS_PER_DAY,
).toISOString();

describe('063 dispatchRenewalCycle — missed-cron catch-up on live Neon', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-catchup-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Catch-up Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Catch-up Co',
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
        email: `catchup-${randomUUID().slice(0, 6)}@acme.example`,
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

  it('fires the T-7 step exactly once (catch-up) + caught_up audit + idempotent on re-run', async () => {
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

    // ----- Pass 1: catch up the missed T-7 step --------------------------
    const r1 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // RED against pre-063 strict-equality code: this was 0 (not_due_today).
    expect(r1.value.summary.emailsSent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);

    // ----- Pass 2: re-run same day → idempotent (already_sent) -----------
    const r2 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.summary.emailsSent).toBe(0);
    expect(r2.value.summary.skipped.already_sent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1); // unchanged

    // ----- DB invariants: exactly 1 reminder_event for the T-7 step ------
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
    expect(reminderRows[0]?.status).toBe('sent');
    expect(reminderRows[0]?.stepId).toBe('t-7.email');
    expect(reminderRows[0]?.yearInCycle).toBe(1);

    // ----- Audit: exactly 1 renewal_reminder_sent carrying caught_up -----
    const sentAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_sent' as never),
        ),
      );
    expect(sentAudits).toHaveLength(1);
    const payload = sentAudits[0]?.payload as {
      step_id?: string;
      caught_up?: boolean;
      step_due_date?: string;
    };
    expect(payload.step_id).toBe('t-7.email');
    expect(payload.caught_up).toBe(true);
    expect(payload.step_due_date).toBe(EXPECTED_DUE_DATE_ISO);

    gatewaySpy.mockRestore();
  }, 120_000);
});
