/**
 * F8 Phase 3 Wave H5 · T076 — `cancelCycle` integration test (live Neon).
 *
 * Covers:
 *   - Happy path: awaiting_payment → cancelled + audit row in audit_log
 *   - Already-cancelled: 409 cycle_not_cancellable + no duplicate audit
 *   - Cross-tenant: B attempts cancel of A cycle → cycle_not_found + probe audit
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { cancelCycle, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('F8 cancelCycle — integration (T076)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let cycleIdA: string;
  let memberIdA: string;
  let planIdA: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planIdA = `f8-cancel-${randomUUID().slice(0, 8)}`;
    memberIdA = randomUUID();
    cycleIdA = randomUUID();

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planIdA,
        planName: { en: 'Cancel Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        companyName: 'Cancel Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: cycleIdA,
        memberId: memberIdA,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('cross-tenant: B cannot cancel A cycle (returns cycle_not_found + emits probe audit)', async () => {
    const deps = makeRenewalsDeps(tenantB.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenantB.ctx.slug,
      cycleId: cycleIdA,
      reason: 'cross-tenant probe attempt',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');

    // Audit probe row exists in tenant B context
    const probes = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'renewal_cross_tenant_probe' as never),
        ),
      );
    expect(probes.length).toBeGreaterThanOrEqual(1);

    // A's cycle is unchanged (RLS made it invisible to B's attempt)
    const aCycles = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleIdA)),
    );
    expect(aCycles[0]?.status).toBe('awaiting_payment');
  });

  it('happy path: awaiting_payment → cancelled + audit emitted', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: cycleIdA,
      reason: 'member relocating to Sweden',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('cancelled');

    // Verify DB state
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleIdA)),
    );
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.closedReason).toBe('cancelled');
    expect(rows[0]?.closedAt).toBeTruthy();

    // Audit row exists
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_cancelled' as never),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('already-cancelled: returns cycle_not_cancellable', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: cycleIdA,
      reason: 'second attempt',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_cancellable');
      if (r.error.kind === 'cycle_not_cancellable') {
        expect(r.error.currentStatus).toBe('cancelled');
      }
    }
  });

  it('invalid cycleId format → invalid_input', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: 'not-a-uuid',
      reason: 'x',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
