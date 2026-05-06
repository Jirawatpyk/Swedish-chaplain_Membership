/**
 * F8 Phase 4 Wave J10 / M12 — concurrent admin send-reminder race.
 *
 * spec.md:197 Edge Case "Concurrent admin actions on same cycle/member"
 * is unit-tested only via a single-call 409 assertion in
 * `send-reminder-now.test.ts`. This integration test verifies the REAL
 * Postgres unique-constraint behaviour under simultaneous calls:
 *
 *   `Promise.all([sendReminderNow(...), sendReminderNow(...)])` —
 *   exactly ONE returns `kind: 'sent'` (the winner), the OTHER returns
 *   `kind: 'skipped', reason: 'already_sent'` (the loser, seeing the
 *   unique-index conflict via insertIfAbsent's ON CONFLICT path).
 *
 * Without this contract, two admins clicking "Send reminder" on the
 * same row in the same second could trigger duplicate Resend dispatches
 * (Resend dedupes server-side on idempotency-key, but our audit log
 * would carry two `renewal_reminder_sent` rows — Constitution Principle
 * VIII state↔audit drift).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { makeRenewalsDeps, sendReminderNow } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';


// Pin clock so the dispatcher's findStepForDate resolves the regular-
// tier T-30 step deterministically.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

describe('F8 concurrent admin send-reminder race (J10-M12)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    memberId = randomUUID();
    cycleId = randomUUID();
    const planId = `f8-m12-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'M12 Plan' },
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
        companyName: 'M12 Race Co',
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
        email: `m12-${randomUUID().slice(0, 6)}@acme.example`,
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
  }, 120_000);

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

  it('Promise.all([sendReminderNow x2]) on same cycle → exactly one sent + one already_sent (FR-011 idempotency under concurrency)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    // Stub gateway so concurrent calls return success quickly without
    // hitting Resend. The unique-index race happens at the
    // `insertIfAbsent` boundary BEFORE the gateway call, so the
    // gateway should be invoked AT MOST once (winner only).
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `m12-mock-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    const correlationA = randomUUID();
    const correlationB = randomUUID();

    // Fire both calls with no await between — the JS event loop will
    // schedule them on the same tick, then both `await` resolve
    // concurrently. Postgres serialises the two `INSERT … ON CONFLICT
    // DO NOTHING` calls via the unique index lock; one row gets
    // inserted, the other path returns `created=false` and
    // sendReminderNow returns `skipped: 'already_sent'`.
    const [a, b] = await Promise.all([
      sendReminderNow(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: correlationA,
        nowIso: NOW_ISO,
      }),
      sendReminderNow(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: correlationB,
        nowIso: NOW_ISO,
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Exactly one 'sent' + one 'skipped:already_sent' — order is
    // non-deterministic (depends on which scheduler tick wins).
    const kinds = [a.value.kind, b.value.kind].sort();
    expect(kinds).toEqual(['sent', 'skipped']);
    const skippedOutcome = a.value.kind === 'skipped' ? a.value : b.value;
    if (skippedOutcome.kind !== 'skipped') {
      throw new Error('exactly one outcome must be skipped');
    }
    expect(skippedOutcome.reason).toBe('already_sent');
    // Loser's metadata carries the existing reminder_event_id —
    // wired through to admin UI 409 toast.
    expect(skippedOutcome.metadata?.existing_reminder_event_id).toBeDefined();

    // Gateway invoked exactly ONCE — second call short-circuited at
    // the insertIfAbsent gate before reaching the gateway.
    expect(gatewaySpy).toHaveBeenCalledTimes(1);

    // DB invariant: exactly ONE reminder_event row exists for this
    // cycle (FR-011 idempotency primitive holds under concurrency).
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(eq(renewalReminderEvents.cycleId, cycleId)),
    );
    expect(reminderRows).toHaveLength(1);
    expect(reminderRows[0]?.status).toBe('sent');

    // Audit invariant: exactly ONE `renewal_reminder_sent` audit row
    // exists. Two would mean state↔audit atomicity broke under
    // concurrency.
    const sentAudits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug));
    const sentCount = sentAudits.filter(
      (a) => (a.eventType as string) === 'renewal_reminder_sent',
    ).length;
    expect(sentCount).toBe(1);

    gatewaySpy.mockRestore();
  }, 90_000);
});
