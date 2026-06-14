/**
 * 070 §86/4 — `loadPlanFrozenFields` cycle-fiscal-year resolution (unit).
 *
 * Regression guard for the latent multi-active-year footgun:
 * `loadPlanFrozenFields` used to resolve a plan by "most-recent ACTIVE
 * row ordered by plan_year DESC", ignoring the cycle's own fiscal year.
 * If a future-year catalogue row is activated (a reasonable admin
 * pre-opening action), a CURRENT-period cycle's frozen §86/4 price would
 * silently resolve to the FUTURE-year row — wrong tax amount, no error.
 *
 * The fix makes resolution exact-year-FIRST: the caller threads the
 * relevant cycle's fiscal year + a `requireActiveForYear` flag. This
 * test locks the branch logic against a controllable fake `tx` query
 * builder (the SQL itself is proven on live Neon in the integration
 * test `tests/integration/renewals/plan-lookup-by-fiscal-year.test.ts`).
 *
 * These are pure-unit branch assertions — the real `ORDER BY plan_year
 * DESC` + `is_active` + composite-PK exact-year semantics are exercised
 * against the actual schema by the integration suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDrizzlePlanLookupForRenewal } from '@/modules/renewals/infrastructure/ports-adapters/plan-lookup-for-renewal-drizzle';
import type { TenantContext } from '@/modules/tenants';

// ── Mock `@/lib/db.runInTenant` to invoke the callback with a
//    controllable fake `tx`. Each test installs a query-result script
//    keyed by call order: the adapter issues at most two SELECTs
//    (exact-year primary, then either the most-recent-active fallback or
//    the inactive probe), so an ordered queue of result-rows is enough.
const txQueue: unknown[][] = [];

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(
    async (
      _tenant: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => {
      // A thenable query-builder: every chained method returns `this`,
      // and awaiting it (or calling `.limit()`/`.then`) yields the next
      // scripted result-row array from `txQueue`.
      const builder: Record<string, unknown> = {};
      const chain = (): typeof builder => builder;
      for (const m of ['select', 'from', 'where', 'orderBy'] as const) {
        builder[m] = vi.fn(chain);
      }
      builder.limit = vi.fn(() => Promise.resolve(txQueue.shift() ?? []));
      const tx = { select: () => builder };
      return fn(tx);
    },
  ),
}));

const tenant = { slug: 'tenant-a' } as unknown as TenantContext;

function queueRows(...batches: unknown[][]): void {
  txQueue.length = 0;
  txQueue.push(...batches);
}

// The exact-year primary SELECT also reads `isActive` (the
// requireActiveForYear branch); the fallback SELECT does not. Both
// fixtures carry it so they serve either query slot.
const ACTIVE_2026 = {
  isActive: true,
  renewalTierBucket: 'regular',
  annualFeeMinorUnits: 5_000_000, // 50,000.00 THB
};
const INACTIVE_2026 = {
  isActive: false,
  renewalTierBucket: 'premium',
  annualFeeMinorUnits: 9_900_000, // 99,000.00 THB
};

describe('makeDrizzlePlanLookupForRenewal — cycle-fiscal-year resolution (070)', () => {
  it('exact-year row present → returns THAT year price (requireActiveForYear:false, active row)', async () => {
    // Primary SELECT returns the 2026 row; no fallback query runs.
    queueRows([ACTIVE_2026]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      requireActiveForYear: false,
    });
    expect(result).toEqual({
      status: 'found',
      plan: {
        tierBucket: 'regular',
        priceTHB: '50000.00',
        termMonths: 12,
        currency: 'THB',
      },
    });
  });

  it('requireActiveForYear:false + INACTIVE exact-year row → found (a seeded next-year price is a valid freeze)', async () => {
    queueRows([INACTIVE_2026]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      requireActiveForYear: false,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.plan.priceTHB).toBe('99000.00');
    expect(result.plan.tierBucket).toBe('premium');
  });

  it('requireActiveForYear:true + ACTIVE exact-year row → found', async () => {
    queueRows([ACTIVE_2026]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      requireActiveForYear: true,
    });
    expect(result.status).toBe('found');
  });

  it('requireActiveForYear:true + INACTIVE exact-year row → plan_inactive (cannot switch to a plan not offered that year; NO fall-through)', async () => {
    // Only the primary SELECT runs; an inactive exact-year row under the
    // plan-change contract is `plan_inactive` — it must NOT fall through
    // to a different year's active row.
    queueRows([INACTIVE_2026]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      requireActiveForYear: true,
    });
    expect(result.status).toBe('plan_inactive');
  });

  it('exact-year MISS → falls back to most-recent ACTIVE row (existing behaviour unchanged)', async () => {
    // Primary SELECT empty (no row for fiscalYear 2099) → fallback SELECT
    // returns the most-recent active row.
    queueRows([], [ACTIVE_2026]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2099,
      requireActiveForYear: false,
    });
    expect(result).toEqual({
      status: 'found',
      plan: {
        tierBucket: 'regular',
        priceTHB: '50000.00',
        termMonths: 12,
        currency: 'THB',
      },
    });
  });

  it('exact-year MISS + no active row + a non-deleted row exists → plan_inactive (distinction preserved)', async () => {
    // Primary empty, fallback active empty, inactive probe returns a row.
    queueRows([], [], [{ one: 1 }]);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2099,
      requireActiveForYear: false,
    });
    expect(result.status).toBe('plan_inactive');
  });

  it('exact-year MISS + no rows at all → not_found (distinction preserved)', async () => {
    queueRows([], [], []);
    const adapter = makeDrizzlePlanLookupForRenewal(tenant);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: 'tenant-a',
      planId: 'missing',
      fiscalYear: 2099,
      requireActiveForYear: true,
    });
    expect(result.status).toBe('not_found');
  });
});
