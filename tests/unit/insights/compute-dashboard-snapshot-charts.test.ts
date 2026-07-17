/**
 * Unit — computeDashboardSnapshot chart aggregates (067-dashboard-interactive-charts Task 5).
 *
 * Injects fake plan + invoice sources and asserts the use-case:
 *   (a) builds `tierDistribution` via the domain `groupActiveMembersByTier`,
 *       resolving each active member's plan label through
 *       `planSource.getPlanLabel` (memoized per distinct plan in the same
 *       loop `getEntitlements` already dedups), with an unresolvable
 *       plan/year falling into the `unassigned` bucket; and
 *   (b) surfaces `invoiceStatus` straight from
 *       `invoiceSource.getInvoiceStatusDistribution`, with each bucket's
 *       `satang` bigint mapped to a JSON-safe decimal string.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@/modules/tenants';
import type { ComputeDashboardSnapshotDeps } from '@/modules/insights/application/use-cases/compute-dashboard-snapshot';
import type { MemberPlanRef } from '@/modules/insights/domain/quota-underuse';
import { groupActiveMembersByTier } from '@/modules/insights/domain/tier-distribution';

// runInTenant just invokes the callback with a throwaway tx (dismissal + upsert).
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

import { computeDashboardSnapshot } from '@/modules/insights/application/use-cases/compute-dashboard-snapshot';

const ctx = { slug: 'test-tenant' } as unknown as TenantContext;

const PLAN_GOLD = { planId: 'corporate-gold', planYear: 2026 };
const PLAN_SILVER = { planId: 'corporate-silver', planYear: 2026 };
const PLAN_UNKNOWN = { planId: 'legacy-plan', planYear: 2019 };

function m(memberId: string, plan: { planId: string; planYear: number }): MemberPlanRef {
  return { memberId, planId: plan.planId, planYear: plan.planYear };
}

const ACTIVE_MEMBERS: readonly MemberPlanRef[] = [
  m('m1', PLAN_GOLD),
  m('m2', PLAN_GOLD),
  m('m3', PLAN_SILVER),
  m('m4', PLAN_UNKNOWN), // unresolved plan/year -> 'unassigned' bucket
];

const LABELS: Record<string, string> = {
  [PLAN_GOLD.planId]: 'Corporate Gold',
  [PLAN_SILVER.planId]: 'Corporate Silver',
};

const INVOICE_DISTRIBUTION = {
  buckets: [
    { bucket: 'paid' as const, satang: 150_000n, count: 3 },
    { bucket: 'unpaid' as const, satang: 20_000n, count: 1 },
    { bucket: 'overdue' as const, satang: 5_000n, count: 1 },
  ],
  draftCount: 2,
};

function makeDeps(): ComputeDashboardSnapshotDeps {
  return {
    memberSource: {
      countByStatus: async () => ({ active: ACTIVE_MEMBERS.length, inactive: 0, archived: 0 }),
      countAtRisk: async () => 0,
      listAtRisk: async () => [],
      joinDistribution: async () => ({ baseline: 0, byMonth: {} }),
    },
    invoiceSource: {
      getYtdPaidRevenueSatang: async () => 0n,
      countOverdue: async () => 0,
      getMonthlyPaidRevenueSatang: async () => ({}),
      getInvoiceStatusDistribution: async () => INVOICE_DISTRIBUTION,
    },
    broadcastSource: { countAwaitingApproval: async () => 0 },
    memberEnumeration: {
      listActiveWithPlan: async () => ACTIVE_MEMBERS,
    },
    consumptionAggregate: {
      eblastUsedByMember: async () => new Map(),
      culturalUsedByMember: async () => new Map(),
    },
    planSource: {
      // No quota cards in scope for this test — every plan grants nothing.
      getEntitlements: async () => null,
      getPlanLabel: async (_c: unknown, planId: string) => LABELS[planId] ?? null,
    },
    snapshotRepo: { upsertInTx: async () => {} },
    dismissalRepo: { isDismissedInTx: async () => false },
    clock: { now: () => new Date('2026-06-15T00:00:00Z') },
    tenantTimezone: 'Asia/Bangkok',
  } as unknown as ComputeDashboardSnapshotDeps;
}

describe('computeDashboardSnapshot — 067 chart aggregates', () => {
  it('builds tierDistribution via groupActiveMembersByTier, resolving labels per distinct plan', async () => {
    const r = await computeDashboardSnapshot(ctx, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const expected = groupActiveMembersByTier(ACTIVE_MEMBERS, (id) => LABELS[id] ?? null);
    expect(r.value.tierDistribution).toEqual(expected);
    expect(r.value.tierDistribution).toEqual([
      { tierKey: 'corporate-gold', label: 'Corporate Gold', count: 2 },
      { tierKey: 'corporate-silver', label: 'Corporate Silver', count: 1 },
      { tierKey: 'unassigned', label: 'unassigned', count: 1 },
    ]);
  });

  it('resolves the NEWEST plan-year label when one planId spans multiple years (deterministic, not first-to-resolve)', async () => {
    // Clone+rename scenario: the SAME plan slug is held under two active
    // years with different stored names. `groupActiveMembersByTier` collapses
    // plan year (groups by planId), so the label shown for the collapsed
    // `corp` bar must deterministically be the newest year's name — never
    // whichever `getPlanLabel` promise happened to settle first.
    const members: MemberPlanRef[] = [
      m('m1', { planId: 'corp', planYear: 2025 }), // older — listed first
      m('m2', { planId: 'corp', planYear: 2026 }), // newer
    ];
    const labelByYear: Record<number, string> = {
      2025: 'Corporate 2025',
      2026: 'Corporate 2026',
    };
    const deps = makeDeps();
    const overridden: ComputeDashboardSnapshotDeps = {
      ...deps,
      memberEnumeration: { listActiveWithPlan: async () => members },
      memberSource: {
        ...deps.memberSource,
        countByStatus: async () => ({ active: members.length, inactive: 0, archived: 0 }),
      },
      planSource: {
        getEntitlements: async () => null,
        getPlanLabel: async (_c: unknown, _planId: string, planYear: number) =>
          labelByYear[planYear] ?? null,
      },
    } as unknown as ComputeDashboardSnapshotDeps;

    const r = await computeDashboardSnapshot(ctx, overridden);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.tierDistribution).toEqual([
      { tierKey: 'corp', label: 'Corporate 2026', count: 2 },
    ]);
  });

  it('maps invoiceStatus straight from InvoiceSource, satang bigint -> decimal string', async () => {
    const r = await computeDashboardSnapshot(ctx, makeDeps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.invoiceStatus).toEqual({
      buckets: [
        { bucket: 'paid', satang: '150000', count: 3 },
        { bucket: 'unpaid', satang: '20000', count: 1 },
        { bucket: 'overdue', satang: '5000', count: 1 },
      ],
      draftCount: 2,
    });
  });
});
