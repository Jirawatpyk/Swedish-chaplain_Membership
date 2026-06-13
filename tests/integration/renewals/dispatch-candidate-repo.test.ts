/**
 * F8-completion Slice 0 · Task 0.1 (G6) — characterization test for the
 * dispatch-candidate query's grace-window inclusion.
 *
 * The `DispatchCandidateRepo.list` filter historically listed a `'grace'`
 * status literal in its `status IN (…)` clause. No DB row can EVER hold
 * `'grace'` — `CYCLE_STATUSES` (7-state set) and the migration `0087`
 * `renewal_cycles_status_check` CHECK both reject it. Grace-window
 * inclusion is achieved entirely by the DATE filter
 * (`expires_at >= NOW() - maxOffsetDays days`), NOT by a status.
 *
 * This characterization test pins that behaviour: a post-expiry
 * grace-window `awaiting_payment` cycle (expires_at = now - 5 days) MUST
 * be returned by `list` via the date window. It is run GREEN both BEFORE
 * and AFTER removing the dead `'grace'` literal — behaviour is unchanged,
 * the literal is provably dead.
 *
 * Tenant isolation: seeds + asserts under `runInTenant`; cleanup runs as
 * BYPASSRLS owner via `db.delete`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeDrizzleDispatchCandidateRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 DispatchCandidateRepo — grace-window inclusion (Task 0.1 / G6)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;
  let graceWindowCycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planId = `f8-grace-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    graceWindowCycleId = randomUUID();

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Grace Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Grace Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    // A post-expiry grace-window cycle: expires_at = now - 5 days, status
    // = awaiting_payment (member is in the grace period awaiting payment).
    const expiresAt = new Date(Date.now() - 5 * MS_PER_DAY);
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: graceWindowCycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(Date.now() - 370 * MS_PER_DAY),
        periodTo: expiresAt,
        expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
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
        .delete(members)
        .where(eq(members.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('includes a post-expiry grace-window cycle via the date filter, not a grace status', async () => {
    const repo = makeDrizzleDispatchCandidateRepo(tenantA.ctx);
    const page = await repo.list(tenantA.ctx.slug, {
      cutoffExpiresAt: new Date(Date.now() + 90 * MS_PER_DAY).toISOString(),
      maxOffsetDays: 30,
      pageSize: 50,
    });
    expect(page.items.map((c) => c.cycle.cycleId)).toContain(graceWindowCycleId);
  });

  it('excludes a cycle whose expiry is OLDER than the grace window (date filter, not status)', async () => {
    // Sanity: a cycle 40 days past expiry falls OUTSIDE maxOffsetDays=30,
    // proving the date window — not any status literal — is what governs
    // grace inclusion. Seed under the same member would collide with the
    // partial-unique active-cycle constraint, so seed a sibling member.
    const staleMemberId = randomUUID();
    const staleCycleId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: staleMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Stale Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    const staleExpiresAt = new Date(Date.now() - 40 * MS_PER_DAY);
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: staleCycleId,
        memberId: staleMemberId,
        status: 'awaiting_payment',
        periodFrom: new Date(Date.now() - 405 * MS_PER_DAY),
        periodTo: staleExpiresAt,
        expiresAt: staleExpiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );

    const repo = makeDrizzleDispatchCandidateRepo(tenantA.ctx);
    const page = await repo.list(tenantA.ctx.slug, {
      cutoffExpiresAt: new Date(Date.now() + 90 * MS_PER_DAY).toISOString(),
      maxOffsetDays: 30,
      pageSize: 50,
    });
    const ids = page.items.map((c) => c.cycle.cycleId);
    expect(ids).toContain(graceWindowCycleId); // still inside window
    expect(ids).not.toContain(staleCycleId); // 40d > 30d → excluded
  });
});
