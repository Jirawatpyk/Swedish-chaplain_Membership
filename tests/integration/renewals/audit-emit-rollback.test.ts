/**
 * F8 Phase 4 Wave J7 / H5 — audit-emit failure rollback integration test
 * (Constitution Principle VIII state↔audit atomicity).
 *
 * Pins the J2-B2 defensive-cleanup contract on a REAL Neon tx rollback:
 * if `auditEmitter.emitInTx` throws AFTER `transitionStatus` has already
 * written to the row in the same tx, the runInTenant tx rolls back. The
 * unit-level J2-B2 test simulates this with a `transitionStatus` mock
 * that throws on first call (because runInTenant is mocked as a
 * passthrough that doesn't actually rollback). This integration test
 * exercises the REAL Postgres rollback semantics + verifies that the
 * defensive cleanup (J2-B2 `defensivelyMarkFailedForRetry`) opens a
 * SECOND tx that flips the orphaned 'pending' row to 'failed' so the
 * retry pass picks it up.
 *
 * Test scope:
 *   - Seed eligible T-30 cycle with primary contact
 *   - Stub gateway → ok (so success path enters runInTenant)
 *   - Spy auditEmitter.emitInTx → throw on `renewal_reminder_sent`
 *     (delegate to real impl for any other event type, so the
 *     defensive-cleanup's `renewal_reminder_send_failed` emit goes
 *     through to a real audit_log row)
 *   - Run dispatchRenewalCycle
 *   - Assert via direct SQL:
 *     1. renewal_reminder_events row status='failed' (NOT 'pending')
 *     2. failureReason starts with 'dispatcher_crash:'
 *     3. retry_until is non-null (within 24h budget)
 *     4. audit_log has a `renewal_reminder_send_failed` row from the
 *        defensive cleanup tx (the original `renewal_reminder_sent`
 *        emit was rolled back)
 *
 * Why this matters: Principle VIII state↔audit atomicity means we
 * either commit BOTH the status flip AND the audit row, OR we commit
 * NEITHER. The defensive cleanup's contract is to ensure the row
 * never orphans at 'pending' — if this test ever regresses, members
 * stop receiving reminders silently when audit_log has DB faults.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';


// T-30 cycle — pin the dispatcher's clock so the schedule policy
// resolves the regular-tier T-30 step deterministically.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

describe('F8 audit-emit failure rollback (J7-H5) — Principle VIII state↔audit atomicity', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);

    memberId = randomUUID();
    cycleId = randomUUID();
    const planId = `f8-h5-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'H5 Plan' },
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
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'H5 Audit Rollback Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Anna',
        lastName: 'Adm',
        email: `h5-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
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
    // FK order: reminder_events → cycles → audit (via tenant cleanup).
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
  }, 120_000);

  it('emit failure inside success-path tx → rollback + defensive transition to failed (NOT orphaned at pending)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Stub gateway as ok so the success path enters the persist tx.
    const mockDeliveryId = `h5-mock-${randomUUID().slice(0, 8)}`;
    vi.spyOn(deps.renewalGateway, 'sendRenewalEmail').mockResolvedValue({
      ok: true,
      value: {
        deliveryId: mockDeliveryId,
        dispatchedAt: NOW_ISO,
      },
    } as never);

    // Capture the real emitInTx so we can pass through for non-target
    // event types (the defensive cleanup's `renewal_reminder_send_failed`
    // emit MUST go through unimpeded so the audit-log assertion at the
    // end of the test sees a real row).
    const realEmitInTx = deps.auditEmitter.emitInTx.bind(deps.auditEmitter);
    let didThrow = false;
    vi.spyOn(deps.auditEmitter, 'emitInTx').mockImplementation(
      async (tx, event, ctx) => {
        if (event.type === 'renewal_reminder_sent' && !didThrow) {
          didThrow = true;
          throw new Error('audit_log: simulated insert failure (J7-H5)');
        }
        return realEmitInTx(tx, event, ctx);
      },
    );

    const summary = await dispatchRenewalCycle(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // The dispatcher's outer try/catch in dispatchOneCycleInner caught
    // the audit-emit throw + ran defensivelyMarkFailedForRetry, which
    // returns failed_transient. Cron tally sees it as a transient
    // failure (NOT silently 'sent').
    expect(summary.value.summary.failedTransient).toBeGreaterThanOrEqual(1);
    expect(summary.value.summary.emailsSent).toBe(0);
    expect(didThrow).toBe(true);

    // Verify the row is at 'failed' (defensive transition), NOT
    // orphaned at 'pending'.
    const reminderRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(eq(renewalReminderEvents.cycleId, cycleId)),
    );
    expect(reminderRows).toHaveLength(1);
    const row = reminderRows[0]!;
    expect(row.status).toBe('failed');
    expect(row.failureReason ?? '').toMatch(/^dispatcher_crash: /);
    // retry_until is set so the retry pass picks it up within 24h.
    expect(row.retryUntil).not.toBeNull();
    expect(row.retryExhaustedAt).toBeNull();
    // No delivery_id — original tx rolled back; defensive cleanup
    // doesn't fabricate one.
    expect(row.deliveryId).toBeNull();

    // The original `renewal_reminder_sent` audit was rolled back when
    // the success-path tx aborted. The defensive cleanup tx then
    // committed a `renewal_reminder_send_failed` audit row.
    const sentAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_sent' as never),
        ),
      );
    expect(sentAudits).toHaveLength(0);
    const failedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_send_failed' as never),
        ),
      );
    expect(failedAudits.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
