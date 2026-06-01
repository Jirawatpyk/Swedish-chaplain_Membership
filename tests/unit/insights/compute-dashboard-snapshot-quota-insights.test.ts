/**
 * Unit — computeDashboardSnapshot quota insights (go-live P1-4 / FR-004).
 *
 * Injects fake quota sources (enumeration + consumption aggregate + plan
 * entitlements) and asserts the use-case (a) emits `unused_eblast_quota` /
 * `underused_event_tickets` with the right counts, (b) sets
 * `underDeliveredBenefitCount` to the UNION, (c) does NOT emit a count=0 card,
 * (d) suppresses a dismissed quota card while a sibling survives, and (e) fails
 * loud (`compute_failed`) when a consumption aggregate throws (never a
 * false-zero count).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '@/modules/tenants';
import type { ComputeDashboardSnapshotDeps } from '@/modules/insights/application/use-cases/compute-dashboard-snapshot';
import type { MemberPlanRef } from '@/modules/insights/domain/quota-underuse';

// runInTenant just invokes the callback with a throwaway tx (dismissal + upsert).
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

import { computeDashboardSnapshot } from '@/modules/insights/application/use-cases/compute-dashboard-snapshot';

const ctx = { slug: 'test-tenant' } as unknown as TenantContext;
const PLAN_A = { planId: 'corporate-gold', planYear: 2026 };
const PLAN_ZERO = { planId: 'partner-basic', planYear: 2026 };

function m(memberId: string, plan = PLAN_A): MemberPlanRef {
  return { memberId, planId: plan.planId, planYear: plan.planYear };
}

interface Overrides {
  activeMembers?: readonly MemberPlanRef[];
  eblastUsed?: ReadonlyMap<string, number>;
  culturalUsed?: ReadonlyMap<string, number>;
  atRisk?: number;
  dismissedKeys?: ReadonlySet<string>;
  throwOnEblast?: boolean;
}

function makeDeps(o: Overrides = {}): ComputeDashboardSnapshotDeps {
  const entitlements: Record<string, { eblastPerYear: number; culturalTicketsPerYear: number }> = {
    [PLAN_A.planId]: { eblastPerYear: 12, culturalTicketsPerYear: 4 },
    [PLAN_ZERO.planId]: { eblastPerYear: 0, culturalTicketsPerYear: 2 },
  };
  return {
    memberSource: {
      countByStatus: async () => ({ active: 3, inactive: 0, archived: 0 }),
      countAtRisk: async () => o.atRisk ?? 0,
      listAtRisk: async () => [],
      joinDistribution: async () => ({ baseline: 0, byMonth: {} }),
    },
    invoiceSource: {
      getYtdPaidRevenueSatang: async () => 0n,
      countOverdue: async () => 0,
      getMonthlyPaidRevenueSatang: async () => ({}),
    },
    broadcastSource: { countAwaitingApproval: async () => 0 },
    memberEnumeration: {
      listActiveWithPlan: async () => o.activeMembers ?? [],
    },
    consumptionAggregate: {
      eblastUsedByMember: async () => {
        if (o.throwOnEblast) throw new Error('neon down');
        return o.eblastUsed ?? new Map();
      },
      culturalUsedByMember: async () => o.culturalUsed ?? new Map(),
    },
    planSource: {
      getEntitlements: async (_c: unknown, planId: string) => {
        const e = entitlements[planId];
        return e ? { ...e, activeBenefits: [] } : null;
      },
    },
    snapshotRepo: { upsertInTx: async () => {} },
    dismissalRepo: {
      isDismissedInTx: async (_tx: unknown, key: string) =>
        (o.dismissedKeys ?? new Set()).has(key),
    },
    clock: { now: () => new Date('2026-06-15T00:00:00Z') },
    tenantTimezone: 'Asia/Bangkok',
  } as unknown as ComputeDashboardSnapshotDeps;
}

function insight(snap: { topInsights: readonly { key: string; count: number }[] }, key: string) {
  return snap.topInsights.find((i) => i.key === key);
}

beforeEach(() => vi.clearAllMocks());

describe('computeDashboardSnapshot — FR-004 quota insights', () => {
  it('emits both quota cards with correct counts + UNION underDeliveredBenefitCount', async () => {
    const r = await computeDashboardSnapshot(
      ctx,
      makeDeps({
        activeMembers: [m('m1'), m('m2'), m('m3', PLAN_ZERO)],
        // m1: 3/12 eblast (under), 4/4 cultural (full)
        // m2: 12/12 eblast (full), 1/4 cultural (under)
        // m3: planZero eblast=0 (excluded), 1/2 cultural (under)
        eblastUsed: new Map([['m1', 3], ['m2', 12], ['m3', 0]]),
        culturalUsed: new Map([['m1', 4], ['m2', 1], ['m3', 1]]),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(insight(r.value, 'unused_eblast_quota')?.count).toBe(1); // m1
    expect(insight(r.value, 'underused_event_tickets')?.count).toBe(2); // m2, m3
    expect(r.value.underDeliveredBenefitCount).toBe(3); // m1 ∪ m2 ∪ m3
  });

  it('does NOT emit a count=0 quota card', async () => {
    const r = await computeDashboardSnapshot(
      ctx,
      makeDeps({
        activeMembers: [m('m1')],
        eblastUsed: new Map([['m1', 12]]), // full
        culturalUsed: new Map([['m1', 4]]), // full
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(insight(r.value, 'unused_eblast_quota')).toBeUndefined();
    expect(insight(r.value, 'underused_event_tickets')).toBeUndefined();
    expect(r.value.underDeliveredBenefitCount).toBe(0);
    expect(r.value.topInsights).toHaveLength(0);
  });

  it('suppresses a dismissed quota card while a sibling card survives', async () => {
    const r = await computeDashboardSnapshot(
      ctx,
      makeDeps({
        activeMembers: [m('m1')],
        eblastUsed: new Map([['m1', 0]]), // under → unused_eblast_quota
        culturalUsed: new Map([['m1', 0]]), // under → underused_event_tickets
        dismissedKeys: new Set(['unused_eblast_quota']),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(insight(r.value, 'unused_eblast_quota')).toBeUndefined(); // dismissed
    expect(insight(r.value, 'underused_event_tickets')?.count).toBe(1); // survives
  });

  it('fails loud (compute_failed) when a consumption aggregate throws — never false-zero', async () => {
    const r = await computeDashboardSnapshot(
      ctx,
      makeDeps({ activeMembers: [m('m1')], throwOnEblast: true }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('compute_failed');
  });
});
