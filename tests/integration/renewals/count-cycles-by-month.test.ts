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

  it('month-filtered pipeline reconciles with the bucket count, suppresses the 90d ceiling, and leaves the urgency summary unchanged', async () => {
    // Fresh tenant slice within the same suite tenant is fine — assert by
    // month membership, not absolute totals, to stay robust to prior rows.
    const live = await seedMember(false);
    // A cycle > 90 days out (BKK 2027-02) — invisible to the urgency window,
    // visible to the month lens.
    await seedCycle({ memberId: live, status: 'upcoming', expiresAt: new Date('2027-02-14T04:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });
    const febBucket = agg.months.find((m) => m.month === '2027-02');
    expect(febBucket).toBeDefined();

    // Baseline summary WITHOUT month filter.
    const base = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      urgency: 't-30',
      limit: 200,
    });

    // Rows WITH month filter — 90d ceiling must be suppressed (Feb 2027 > 90d).
    const monthPage = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: '2027-02',
      nowIso: NOW_ISO,
      limit: 200,
    });

    // Reconciliation: rows returned for the month == the bucket count.
    // NB: the RED for this case (rows=5 vs bucket=2, pre-fix) is real-wall-
    // clock-coupled — it reproduces only while NOW() < ~2026-11, before the
    // Feb-2027 cycle enters the old 90-day ceiling. The GREEN assertion below
    // is wall-clock-STABLE: the month lens binds `nowIso`, not `NOW()`.
    expect(monthPage.rows.length).toBe(febBucket!.count);
    expect(
      monthPage.rows.every((r) => r.expiresAt >= '2027-02' && r.expiresAt < '2027-03'),
    ).toBe(true);

    // F3: the urgency summary + lapsed count are identical with/without month.
    expect(monthPage.summary.byUrgency).toEqual(base.summary.byUrgency);
    expect(monthPage.summary.lapsedCount).toBe(base.summary.lapsedCount);
  });

  it('overdue month lens reconciles with agg.overdueCount and runtime-exercises the overdue .toISOString() bound', async () => {
    // Fresh distinct member (renewal_cycles_active_member_uniq allows one
    // open cycle per member) with an OVERDUE open cycle — BKK 2026-04, before
    // the current BKK month (2026-07). This is the FIRST test to drive the
    // `monthFilter: 'overdue'` branch of monthBoundPredicate at runtime.
    const overdue = await seedMember(false);
    await seedCycle({ memberId: overdue, status: 'upcoming', expiresAt: new Date('2026-04-10T04:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });
    expect(agg.overdueCount).toBeGreaterThan(0);

    const page = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: 'overdue',
      nowIso: NOW_ISO,
      limit: 200,
    });

    // Reconciliation: overdue rows == the overdue bucket count.
    expect(page.rows.length).toBe(agg.overdueCount);
    // Every overdue row expires before the first BKK instant of the current
    // month (2026-07). Lexicographic ISO-string compare is a valid sanity
    // bound here — all seeded overdue cycles are mid-month/mid-day.
    expect(page.rows.every((r) => r.expiresAt < '2026-07')).toBe(true);
  });

  it('later month lens reconciles with agg.laterCount and runtime-exercises the later .toISOString() bound', async () => {
    // Fresh distinct member with a cycle comfortably past now+12mo — BKK
    // 2027-09, beyond the 2027-07 `later` boundary. FIRST test to drive the
    // `monthFilter: 'later'` branch of monthBoundPredicate at runtime.
    const later = await seedMember(false);
    await seedCycle({ memberId: later, status: 'upcoming', expiresAt: new Date('2027-09-05T04:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });
    expect(agg.laterCount).toBeGreaterThan(0);

    const page = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: 'later',
      nowIso: NOW_ISO,
      limit: 200,
    });

    // Reconciliation: later rows == the later bucket count.
    expect(page.rows.length).toBe(agg.laterCount);
    expect(page.rows.every((r) => r.expiresAt >= '2027-07')).toBe(true);
  });

  it('buckets a cycle at the first BKK instant of a month into that month (half-open lower bound == to_char grouping)', async () => {
    // 2027-03-31T17:00:00Z == 2027-04-01T00:00:00+07:00 — the FIRST BKK
    // instant of 2027-04. The half-open lower bound is INCLUSIVE, so this must
    // bucket into 2027-04 (matching `to_char(... AT TIME ZONE 'Asia/Bangkok')`
    // = '2027-04'), NOT the exclusive upper bound of 2027-03.
    const edge = await seedMember(false);
    await seedCycle({ memberId: edge, status: 'upcoming', expiresAt: new Date('2027-03-31T17:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const aprPage = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: '2027-04',
      nowIso: NOW_ISO,
      limit: 200,
    });
    const marPage = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: '2027-03',
      nowIso: NOW_ISO,
      limit: 200,
    });

    // Membership assertion (exact) — lexicographic month compares are
    // deliberately NOT used at this boundary, where they would mislead.
    expect(aprPage.rows.some((r) => r.memberId === edge)).toBe(true);
    expect(marPage.rows.some((r) => r.memberId === edge)).toBe(false);
  });

  it('does not count another tenant\'s cycles — RLS cross-tenant isolation (#7)', async () => {
    // Second, fully independent tenant + owner. `seedMember`/`seedCycle`
    // above close over the suite's `tenant` variable, so a foreign-tenant
    // seed needs its own inline variant bound to `otherTenant.ctx`.
    const otherTenant = await createTestTenant();
    const otherOwner = await createActiveTestUser('admin');
    try {
      // Prerequisite membership_plans row for the OTHER tenant — same
      // composite-FK requirement as the suite tenant's beforeAll seed.
      await runInTenant(otherTenant.ctx, (tx) =>
        tx
          .insert(membershipPlans)
          .values({
            tenantId: otherTenant.ctx.slug,
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
            createdBy: otherOwner.userId,
            updatedBy: otherOwner.userId,
          })
          .onConflictDoNothing(),
      );

      // Tenant A's aggregation BEFORE the foreign tenant has any rows.
      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const before = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
        nowIso: NOW_ISO,
        timezone: 'Asia/Bangkok',
      });
      const totalOf = (agg: typeof before): number =>
        agg.overdueCount + agg.laterCount + agg.months.reduce((s, m) => s + m.count, 0);
      const beforeTotal = totalOf(before);

      // Seed an IN-WINDOW open cycle (BKK 2026-07, the current month) for a
      // member owned by the OTHER tenant.
      const foreignMemberId = randomUUID();
      await runInTenant(otherTenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: otherTenant.ctx.slug,
          memberId: foreignMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Co ${foreignMemberId.slice(0, 6)}`,
          country: 'TH',
          planId: 'regular',
          planYear: 2026,
        }),
      );
      await runInTenant(otherTenant.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: otherTenant.ctx.slug,
          cycleId: randomUUID(),
          memberId: foreignMemberId,
          status: 'upcoming',
          periodFrom: new Date('2025-07-20T04:00:00Z'),
          periodTo: new Date('2026-07-20T04:00:00Z'),
          expiresAt: new Date('2026-07-20T04:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: 'regular',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        }),
      );

      // Tenant A's aggregation AFTER the foreign seed — RLS must keep it
      // byte-for-byte unchanged; the foreign cycle must never leak in.
      const after = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
        nowIso: NOW_ISO,
        timezone: 'Asia/Bangkok',
      });
      expect(totalOf(after)).toBe(beforeTotal);
      expect(after).toEqual(before);

      // Positive control: the OTHER tenant's own view DOES see its cycle,
      // proving the seed landed and the isolation assertion above isn't
      // vacuously true because nothing was ever written.
      const otherDeps = makeRenewalsDeps(otherTenant.ctx.slug);
      const otherAgg = await otherDeps.cyclesRepo.countCyclesByExpiryMonth(
        otherTenant.ctx.slug,
        { nowIso: NOW_ISO, timezone: 'Asia/Bangkok' },
      );
      const otherJulyCount = otherAgg.months.find((m) => m.month === '2026-07')?.count ?? 0;
      expect(otherJulyCount).toBe(1);
    } finally {
      await otherTenant.cleanup().catch(() => {});
      await deleteTestUser(otherOwner).catch(() => {});
    }
  });
});
