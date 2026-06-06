/**
 * Pass A · Section 1 — `loadMemberRenewalStatus` integration (live Neon).
 *
 * Covers the admin member-detail "Renewal & Health" read end-to-end against
 * real Postgres RLS:
 *   - Returns the MOST-RECENT cycle (created_at_desc) when a member has
 *     more than one.
 *   - Surfaces a terminal (lapsed) cycle — status is shown, not hidden.
 *   - Returns cycle=null for a member with no renewal cycle (empty state).
 *   - Cross-tenant isolation (Constitution Principle I): tenant B's deps see
 *     NONE of tenant A's cycles for the same memberId.
 *
 * All seed data is SIMULATED (random UUID member ids + fake company names) —
 * never references real SweCham PII.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadMemberRenewalStatus, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const DAY_MS = 86_400_000;

describe('F8 loadMemberRenewalStatus — integration (Pass A · Section 1)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // Member with TWO cycles — newest (awaiting_payment) must win.
  const multiMemberId = randomUUID();
  const olderCycleId = randomUUID();
  const newerCycleId = randomUUID();
  // Member with a single lapsed cycle.
  const lapsedMemberId = randomUUID();
  const lapsedCycleId = randomUUID();
  // Member with no cycle at all.
  const noCycleMemberId = randomUUID();

  let planId: string;

  async function seedMember(t: TestTenant, memberId: string) {
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co ${memberId.slice(0, 4)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      }),
    );
  }

  async function seedCycle(
    t: TestTenant,
    args: {
      cycleId: string;
      memberId: string;
      status: 'awaiting_payment' | 'cancelled' | 'lapsed';
      createdAt: Date;
      expiresAt: Date;
      closedAt?: Date;
      closedReason?: 'grace_expired' | 'cancelled';
    },
  ) {
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId: args.cycleId,
        memberId: args.memberId,
        status: args.status,
        periodFrom: new Date(args.expiresAt.getTime() - 365 * DAY_MS),
        periodTo: args.expiresAt,
        expiresAt: args.expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: args.createdAt,
        ...(args.closedAt ? { closedAt: args.closedAt } : {}),
        ...(args.closedReason ? { closedReason: args.closedReason } : {}),
      }),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planId = `f8-mrs-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Renewal Health Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    const now = Date.now();
    await seedMember(tenantA, multiMemberId);
    await seedMember(tenantA, lapsedMemberId);
    await seedMember(tenantA, noCycleMemberId);

    // Older cycle (terminal `cancelled`, created 60d ago) + newer ACTIVE
    // cycle (created 5d ago). The partial unique index
    // `renewal_cycles_active_member_uniq` allows at most one non-terminal
    // cycle per member, so the prior cycle must be terminal — newer wins
    // by `created_at DESC`. `cancelled` is used (not `completed`) so the
    // seed needs no real F4 invoice row for the linked_invoice_id FK.
    await seedCycle(tenantA, {
      cycleId: olderCycleId,
      memberId: multiMemberId,
      status: 'cancelled',
      createdAt: new Date(now - 60 * DAY_MS),
      expiresAt: new Date(now - 30 * DAY_MS),
      closedAt: new Date(now - 35 * DAY_MS),
      closedReason: 'cancelled',
    });
    await seedCycle(tenantA, {
      cycleId: newerCycleId,
      memberId: multiMemberId,
      status: 'awaiting_payment',
      createdAt: new Date(now - 5 * DAY_MS),
      expiresAt: new Date(now + 20 * DAY_MS),
    });
    await seedCycle(tenantA, {
      cycleId: lapsedCycleId,
      memberId: lapsedMemberId,
      status: 'lapsed',
      createdAt: new Date(now - 90 * DAY_MS),
      expiresAt: new Date(now - 30 * DAY_MS),
      closedAt: new Date(now - 25 * DAY_MS),
      closedReason: 'grace_expired',
    });
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('returns the most-recent cycle when the member has several', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMemberRenewalStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: multiMemberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle?.cycleId).toBe(newerCycleId);
    expect(res.value.cycle?.status).toBe('awaiting_payment');
  });

  it('surfaces a terminal (lapsed) cycle', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMemberRenewalStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: lapsedMemberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle?.status).toBe('lapsed');
  });

  it('returns cycle=null for a member with no renewal cycle', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMemberRenewalStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: noCycleMemberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle).toBeNull();
  });

  it('tenant B cannot see tenant A cycles (Principle I isolation)', async () => {
    const depsB = makeRenewalsDeps(tenantB.ctx.slug);
    const res = await loadMemberRenewalStatus(depsB, {
      tenantId: tenantB.ctx.slug,
      memberId: multiMemberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle).toBeNull();
  });
});
