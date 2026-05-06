/**
 * F8 Phase 4 Wave I8 · T112 — reminder pause after outreach (live Neon).
 *
 * FR-033 contract: when an admin records an at-risk outreach for a
 * member, the dispatcher MUST suppress reminder emails for that member
 * for `REMINDER_PAUSE_WINDOW_DAYS` (= 7 days) regardless of which
 * step is due. The pause is shared across cycles for the same member —
 * one outreach record pauses all of that member's renewal reminders.
 *
 * Test scope:
 *   1. Member at T-30 with FRESH outreach (1 day old) → cron pass
 *      yields outcome `skipped: 'outreach_in_progress'` + audit emitted
 *      with `latest_outreach_at` payload field.
 *   2. Same setup with STALE outreach (8 days old) → pause has lapsed,
 *      cron pass dispatches the reminder (`outcome: sent`).
 *
 * The 7-day window is the SOURCE OF TRUTH `REMINDER_PAUSE_WINDOW_DAYS`
 * exported from the use-case. Test pins behaviour, not the literal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { atRiskOutreach } from '@/modules/renewals/infrastructure/schema-at-risk-outreach';
import {
  dispatchRenewalCycle,
  makeRenewalsDeps,
  REMINDER_PAUSE_WINDOW_DAYS,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';


// `at_risk_outreach.createdAt` filter (`hasOutreachWithinDays`) uses
// Postgres `NOW()` — NOT the dispatcher's injected `nowIso` clock. The
// fixture timestamps therefore have to be real-time-relative or the
// "stale" case is misclassified as fresh.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REAL_NOW_MS = Date.now();
const NOW_ISO = new Date(REAL_NOW_MS).toISOString();
// Cycle expires 30 days from real-now → dispatcher's T-30 step matches.
const EXPIRES_AT = new Date(REAL_NOW_MS + 30 * MS_PER_DAY);
// 1-year cycle → period_from is real-now − 335 days (so T-30 from now).
const PERIOD_FROM = new Date(REAL_NOW_MS - 335 * MS_PER_DAY);

const FRESH_OUTREACH_AGE_DAYS = 1;
const STALE_OUTREACH_AGE_DAYS = REMINDER_PAUSE_WINDOW_DAYS + 1; // beyond window

async function seedMember(
  tenantA: TestTenant,
  user: TestUser,
  opts: { outreachAgeDays: number },
): Promise<{ memberId: string; cycleId: string }> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-pause-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenantA.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenantA.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Pause Plan' },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
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
    await tx.insert(members).values({
      tenantId: tenantA.ctx.slug,
      memberId,
      companyName: 'Pause Co',
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
      email: `pause-${randomUUID().slice(0, 6)}@acme.example`,
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
    await tx.insert(atRiskOutreach).values({
      tenantId: tenantA.ctx.slug,
      outreachId: randomUUID(),
      memberId,
      channel: 'phone',
      outcomeNote: `seeded ${opts.outreachAgeDays}d ago`,
      actorUserId: user.userId,
      createdAt: new Date(REAL_NOW_MS - opts.outreachAgeDays * MS_PER_DAY),
    });
  });
  return { memberId, cycleId };
}

describe('F8 reminder pause after outreach — integration (T112)', () => {
  let tenantA: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(atRiskOutreach)
      .where(eq(atRiskOutreach.tenantId, tenantA.ctx.slug))
      .catch(() => {});
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

  // J10 — test isolation fix (chamber-os-ux #6 / pr-test-analyzer #6).
  // Previously the second test relied on the first test's seeded
  // member persisting in the candidate set; now each test starts
  // from a clean tenant by clearing reminder_events + cycles +
  // outreach rows. Members + plans persist (cleared in afterAll)
  // but they're filtered OUT of the candidate set when no active
  // cycle exists.
  beforeEach(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(atRiskOutreach)
      .where(eq(atRiskOutreach.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
  });

  it('FRESH outreach (1d old): cron pass skips reminder + emits outreach_in_progress audit', async () => {
    const { cycleId } = await seedMember(tenantA, user, {
      outreachAgeDays: FRESH_OUTREACH_AGE_DAYS,
    });

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi.spyOn(deps.renewalGateway, 'sendRenewalEmail');

    const r = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.candidatesProcessed).toBe(1);
    expect(r.value.summary.emailsSent).toBe(0);
    expect(r.value.summary.skipped.outreach_in_progress).toBe(1);
    expect(gatewaySpy).not.toHaveBeenCalled();

    // No reminder_event row was created.
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
    expect(reminderRows).toHaveLength(0);

    // renewal_reminder_skipped audit emitted with reason payload.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_skipped' as never),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const pauseAudit = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.reason ===
        'outreach_in_progress',
    );
    expect(pauseAudit).toBeDefined();

    gatewaySpy.mockRestore();
  }, 120_000);

  it('STALE outreach (>7d old): cron pass dispatches the reminder', async () => {
    const { cycleId } = await seedMember(tenantA, user, {
      outreachAgeDays: STALE_OUTREACH_AGE_DAYS,
    });

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-${randomUUID().slice(0, 8)}`,
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
    // J10: post-isolation-fix the candidate set contains exactly
    // the stale-outreach member (beforeEach clears all reminder
    // events + outreach + cycles from the tenant). No order
    // dependency on the previous test.
    expect(r.value.summary.emailsSent).toBe(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);

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

    gatewaySpy.mockRestore();
  }, 120_000);
});
