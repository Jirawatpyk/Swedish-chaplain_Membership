/**
 * Renewals-by-month — Task 2 integration test for the repo aggregation
 * `countCyclesByExpiryMonth`.
 *
 * Seeds a `membership_plans` row (FK prerequisite for `members.plan_id`)
 * + `members` rows + `renewal_cycles` rows directly via Drizzle, mirroring
 * the column sets `tests/integration/helpers/seed-renewal-cycle.ts` uses
 * (NOT the `status`/`registrationDate` columns — those don't exist on the
 * `members` insert path used by that helper; `status` defaults to
 * `'active'` and `registration_date` defaults to `now()` at the DB layer).
 *
 * Live Neon DEV branch (`.env.local`) — real RLS, real `to_char(...
 * 'Asia/Bangkok', 'YYYY-MM')` grouping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Fixed "now" so the 12-month window + overdue/later thresholds are stable.
const NOW_ISO = '2026-07-10T05:00:00Z'; // BKK 2026-07-10 12:00 → window 2026-07…2027-06

describe('countCyclesByExpiryMonth — integration', () => {
  let tenant: TestTenant;
  let owner: TestUser;

  beforeAll(async () => {
    owner = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    // Prerequisite membership_plans row — members.plan_id has a composite
    // FK to (tenant_id, plan_id, plan_year). Mirrors
    // seed-renewal-cycle.ts:100-125.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .insert(membershipPlans)
        .values({
          tenantId: tenant.ctx.slug,
          planId: 'regular',
          planYear: 2026,
          planName: { en: 'Test regular' },
          description: { en: 'Test regular description' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 5_000_000,
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          isActive: true,
          createdBy: owner.userId,
          updatedBy: owner.userId,
        })
        .onConflictDoNothing(),
    );
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(owner).catch(() => {});
  }, 60_000);

  async function seedMember(erased: boolean): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        ...(erased ? { erasedAt: new Date() } : {}),
      }),
    );
    return memberId;
  }

  async function seedCycle(args: {
    memberId: string;
    status: string;
    expiresAt: Date;
    /**
     * `renewal_cycles_closed_at_iff_terminal_check` requires `closed_at`
     * NOT NULL iff `status IN ('completed','lapsed','cancelled')`.
     */
    closedAt?: Date;
    /**
     * `renewal_cycles_pending_at_iff_pending_status_check` requires
     * `entered_pending_at` NOT NULL iff `status = 'pending_admin_reactivation'`.
     */
    enteredPendingAt?: Date;
  }): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId: args.memberId,
        status: args.status,
        periodFrom: new Date(args.expiresAt.getTime() - 365 * MS_PER_DAY),
        periodTo: args.expiresAt,
        expiresAt: args.expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        ...(args.closedAt ? { closedAt: args.closedAt } : {}),
        ...(args.enteredPendingAt ? { enteredPendingAt: args.enteredPendingAt } : {}),
      }),
    );
  }

  it('folds counts into overdue / window months / later and excludes erased + terminal', async () => {
    // `renewal_cycles_active_member_uniq` (migration 0087) is a partial
    // UNIQUE on (tenant_id, member_id) WHERE status NOT IN ('lapsed',
    // 'cancelled', 'completed') — i.e. a member may have AT MOST ONE row
    // in upcoming/reminded/awaiting_payment/pending_admin_reactivation at
    // a time. Each non-terminal cycle below therefore needs its OWN
    // member; only the exempted terminal statuses (lapsed, completed) can
    // safely share a member with an existing non-terminal cycle.
    const overdueMember = await seedMember(false);
    const julyMemberA = await seedMember(false);
    const julyMemberB = await seedMember(false);
    const febMember = await seedMember(false);
    const laterMember = await seedMember(false);
    const pendingMember = await seedMember(false);
    const erased = await seedMember(true);

    // overdue (BKK 2026-05)
    await seedCycle({ memberId: overdueMember, status: 'upcoming', expiresAt: new Date('2026-05-15T04:00:00Z') });
    // current window month 2026-07 (BKK) — two members
    await seedCycle({ memberId: julyMemberA, status: 'reminded', expiresAt: new Date('2026-07-20T04:00:00Z') });
    await seedCycle({ memberId: julyMemberB, status: 'awaiting_payment', expiresAt: new Date('2026-07-25T04:00:00Z') });
    // window month 2027-02
    await seedCycle({ memberId: febMember, status: 'upcoming', expiresAt: new Date('2027-02-10T04:00:00Z') });
    // later (== now + 12mo boundary, BKK 2027-07)
    await seedCycle({ memberId: laterMember, status: 'upcoming', expiresAt: new Date('2027-07-05T04:00:00Z') });
    // EXCLUDED: erased member's live cycle
    await seedCycle({ memberId: erased, status: 'upcoming', expiresAt: new Date('2026-07-20T04:00:00Z') });
    // EXCLUDED: terminal statuses — exempt from the active-member unique
    // index, so both can safely share `overdueMember` (which already owns
    // the non-terminal 'upcoming' overdue cycle above). `closed_at` is
    // required by the terminal CHECK; `'cancelled'` (unlike `'completed'`)
    // does NOT also require a `linked_invoice_id` FK, so it avoids seeding
    // a real invoice row just to exercise the exclusion.
    const closedAt = new Date('2026-07-21T00:00:00Z');
    await seedCycle({ memberId: overdueMember, status: 'lapsed', expiresAt: new Date('2026-07-20T04:00:00Z'), closedAt });
    await seedCycle({ memberId: overdueMember, status: 'cancelled', expiresAt: new Date('2026-07-20T04:00:00Z'), closedAt });
    // EXCLUDED: pending_admin_reactivation — NOT exempt from the unique
    // index (only lapsed/cancelled/completed are), so it needs its own member.
    await seedCycle({
      memberId: pendingMember,
      status: 'pending_admin_reactivation',
      expiresAt: new Date('2026-07-20T04:00:00Z'),
      enteredPendingAt: new Date('2026-07-15T00:00:00Z'),
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });

    expect(agg.overdueCount).toBe(1);
    expect(agg.laterCount).toBe(1);
    const map = new Map(agg.months.map((m) => [m.month, m.count]));
    expect(map.get('2026-07')).toBe(2);
    expect(map.get('2027-02')).toBe(1);
    // erased + terminal + pending_admin_reactivation never counted:
    const total =
      agg.overdueCount + agg.laterCount + agg.months.reduce((s, m) => s + m.count, 0);
    expect(total).toBe(5);
  });
});
