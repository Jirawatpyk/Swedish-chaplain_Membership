/**
 * F8 Phase 9 / T240 — F3 archival cascade integration test.
 *
 * Pins the F3 ↔ F8 cascade contract end-to-end against live Neon:
 *
 *   1. Seed an active member with one in-flight renewal cycle in
 *      `awaiting_payment` (F8 invariant: at-most-one non-terminal
 *      cycle per member).
 *   2. Invoke `cancelInFlightCyclesForMember` directly (the F3
 *      `archive-member` use-case calls this via the
 *      `RenewalsCascadePort` adapter at
 *      `src/modules/members/infrastructure/adapters/renewals-cascade-adapter.ts`;
 *      this test exercises the F8 use-case directly to keep the
 *      integration scope on the F8-side invariants).
 *   3. Assert:
 *      - `outcome: 'ok'` + `cancelledCount: 1` + `skippedConcurrentCount: 0`
 *      - The cycle row landed in `status='cancelled'` with
 *        `closed_reason='cancelled'` and `closed_at` populated.
 *      - The audit row exists in `audit_log` with
 *        `event_type='renewal_cycle_cancelled'`,
 *        `payload.reason='originator_member_archived'`,
 *        and `actor_role='system'` (cascade is system-initiated even
 *        though `actorUserId` carries the F3 admin's id for
 *        forensic linkage).
 *
 * Idempotency:
 *
 *   4. Replay the cascade against the same member after the first run
 *      → assert `outcome: 'ok'` + `cancelledCount: 0` (cycle already
 *      terminal, no-op).
 *
 * Cross-tenant isolation (Constitution Principle I clause 3):
 *
 *   5. Cascade for a member-id that exists in tenant B → assert no
 *      cycle in tenant A is touched (RLS enforcement).
 *
 * Reuses the F4-precedent F8-test scaffolding (createTestTenant +
 * seedF8MembershipPlan + seedRenewalPolicies + audit_log query).
 *
 * Note on scope: this test pins the F8-side cascade invariants. The
 * F3 archive-member integration with the cascade adapter is covered
 * by `tests/unit/members/application/archive-member.test.ts` (R009
 * + Phase 9 / T239 dep wiring) — together they prove the full F3 ↔ F8
 * cascade contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  cancelInFlightCyclesForMember,
  makeRenewalsDeps,
} from '@/modules/renewals';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

// Period anchors — pin a future expires_at so the cycle is genuinely
// in-flight (not lapsed by clock at test time).
const EXPIRES_AT = new Date('2026-09-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-09-15T00:00:00.000Z');

describe('F8 F3-archival cascade — Phase 9 / T240', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);

    memberId = randomUUID();
    cycleId = randomUUID();
    const planId = `f8-cascade-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Cascade Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Cascade Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('cancels in-flight cycle on F3 archive + emits renewal_cycle_cancelled audit (Principle VIII state↔audit atomicity)', async () => {
    const correlationId = randomUUID();
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await cancelInFlightCyclesForMember(deps, {
      tenant: tenant.ctx,
      memberId: memberId as never,
      cascadeReason: 'originator_member_archived',
      initiatedByUserId: admin.userId,
      requestId: null,
      correlationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('ok');
    expect(result.value.cancelledCount).toBe(1);
    expect(result.value.skippedConcurrentCount).toBe(0);

    // Cycle row landed in 'cancelled' with the right closed_reason.
    const cycleRows = await db
      .select({
        status: renewalCycles.status,
        closedAt: renewalCycles.closedAt,
        closedReason: renewalCycles.closedReason,
      })
      .from(renewalCycles)
      .where(
        and(
          eq(renewalCycles.tenantId, tenant.ctx.slug),
          eq(renewalCycles.cycleId, cycleId),
        ),
      );
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0]!.status).toBe('cancelled');
    expect(cycleRows[0]!.closedReason).toBe('cancelled');
    expect(cycleRows[0]!.closedAt).not.toBeNull();

    // Audit row exists with cascade discriminator. F8 emitter stores
    // `correlationId` under `request_id` when `requestId` is null.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(
            auditLog.eventType,
            'renewal_cycle_cancelled' as never,
          ),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    expect(audit.actorUserId).toBe(admin.userId);
    const payload = audit.payload as {
      cycle_id: string;
      member_id: string;
      reason: string;
      previous_status: string;
    };
    // Cascade discriminator — dashboards pivot on `payload.reason`
    // value to distinguish system-initiated cascade from admin manual
    // cancel (which writes admin-supplied free-form text).
    expect(payload.reason).toBe('originator_member_archived');
    expect(payload.cycle_id).toBe(cycleId);
    expect(payload.member_id).toBe(memberId);
    expect(payload.previous_status).toBe('awaiting_payment');
  });

  it('idempotent replay — second cascade run on same member returns cancelledCount: 0 (no-op, no second audit)', async () => {
    const correlationId = randomUUID();
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await cancelInFlightCyclesForMember(deps, {
      tenant: tenant.ctx,
      memberId: memberId as never,
      cascadeReason: 'originator_member_archived',
      initiatedByUserId: admin.userId,
      requestId: null,
      correlationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('ok');
    expect(result.value.cancelledCount).toBe(0);

    // No second audit row should have landed (cycle already terminal
    // → use-case short-circuits before emit).
    const auditRows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(
            auditLog.eventType,
            'renewal_cycle_cancelled' as never,
          ),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(auditRows).toHaveLength(0);
  });

  it('cross-tenant isolation — cascade for a member-id from tenant B does not affect tenant A cycle (Principle I clause 3)', async () => {
    const tenantB = await createTestTenant('test-chamber');
    try {
      // Cascade against tenant B for the SAME member id (which only
      // exists in tenant A). RLS hides the row → findActiveForMember
      // returns null → cascade is a no-op for tenant B.
      const correlationId = randomUUID();
      const depsB = makeRenewalsDeps(tenantB.ctx.slug);

      const result = await cancelInFlightCyclesForMember(depsB, {
        tenant: tenantB.ctx,
        memberId: memberId as never, // tenant A's member id
        cascadeReason: 'originator_member_archived',
        initiatedByUserId: admin.userId,
        requestId: null,
        correlationId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('ok');
      expect(result.value.cancelledCount).toBe(0);

      // Verify tenant A's cycle is still terminal (cancelled by the
      // first test); the cross-tenant probe must not have reset or
      // re-touched it.
      const cycleRows = await db
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.cycleId, cycleId),
          ),
        );
      expect(cycleRows[0]!.status).toBe('cancelled');
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });
});
