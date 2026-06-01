/**
 * Unit — benefitConsumptionAggregateAdapter (go-live P1-4 / FR-004).
 *
 * Two layers:
 *   1. `toCountMap` (pure) — the only non-SQL logic: drop null group-keys
 *      (non-member rows), map memberId → count.
 *   2. Each method wires `runInTenant(tx)` → query → `toCountMap` and FAILS
 *      LOUD (rejects, never an empty Map) on a DB error. The SQL FILTERS
 *      themselves are pinned by the live-Neon equivalence integration test
 *      (`quota-insights-snapshot`), the correct layer for SQL correctness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

// Mutable canned result the mocked tx query resolves to (or throws).
let nextRows: ReadonlyArray<{ memberId: string | null; used: number }> = [];
let nextError: Error | null = null;

function chainTx() {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'groupBy']) {
    chain[m] = () => chain;
  }
  // The error surfaces at the QUERY level (the awaited `tx.select()...groupBy()`),
  // NOT at runInTenant — so the fail-loud test exercises the adapter's real
  // `await <query>` rejection path, not a short-circuit before the callback runs.
  chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => {
    if (nextError) {
      onR(nextError);
      return undefined;
    }
    return Promise.resolve(nextRows).then(onF);
  };
  return { select: () => chain };
}

vi.mock('@/lib/db', () => ({
  // Always invoke the callback with the chain-mock tx; the query thenable rejects
  // when nextError is set, so the adapter's own try/await propagates it (fail-loud).
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(chainTx()),
}));
vi.mock('@/lib/env', () => ({
  env: { tenant: { timezone: 'Asia/Bangkok' } },
}));

import {
  benefitConsumptionAggregateAdapter,
  toCountMap,
} from '@/modules/insights/infrastructure/sources/benefit-consumption-aggregate-adapter';

const ctx = { slug: 'test-tenant' } as unknown as TenantContext;

beforeEach(() => {
  nextRows = [];
  nextError = null;
});

describe('toCountMap', () => {
  it('maps memberId → count and skips null group-keys (non-member rows)', () => {
    const map = toCountMap([
      { memberId: 'm1', used: 3 },
      { memberId: null, used: 9 }, // unmatched/orphaned → dropped
      { memberId: 'm2', used: 0 },
    ]);
    expect(map.get('m1')).toBe(3);
    expect(map.get('m2')).toBe(0);
    expect(map.has('m1')).toBe(true);
    expect([...map.keys()]).toEqual(['m1', 'm2']);
  });

  it('empty rows → empty map', () => {
    expect(toCountMap([]).size).toBe(0);
  });
});

describe('eblastUsedByMember', () => {
  it('builds memberId → sent-count Map from the grouped rows', async () => {
    nextRows = [
      { memberId: 'm1', used: 5 },
      { memberId: 'm2', used: 1 },
    ];
    const map = await benefitConsumptionAggregateAdapter.eblastUsedByMember(ctx, 2026);
    expect(map.get('m1')).toBe(5);
    expect(map.get('m2')).toBe(1);
    expect(map.get('absent') ?? 0).toBe(0); // absent ⇒ caller reads 0
  });

  it('fails loud — a DB error rejects (never an empty Map)', async () => {
    nextError = new Error('neon down');
    await expect(
      benefitConsumptionAggregateAdapter.eblastUsedByMember(ctx, 2026),
    ).rejects.toThrow(/neon down/);
  });
});

describe('culturalUsedByMember', () => {
  it('builds memberId → attended-count Map from the grouped rows', async () => {
    nextRows = [{ memberId: 'm1', used: 2 }];
    const map = await benefitConsumptionAggregateAdapter.culturalUsedByMember(ctx, 2026);
    expect(map.get('m1')).toBe(2);
    expect(map.size).toBe(1);
  });

  it('fails loud — a DB error rejects (never an empty Map)', async () => {
    nextError = new Error('rls fault');
    await expect(
      benefitConsumptionAggregateAdapter.culturalUsedByMember(ctx, 2026),
    ).rejects.toThrow(/rls fault/);
  });
});
