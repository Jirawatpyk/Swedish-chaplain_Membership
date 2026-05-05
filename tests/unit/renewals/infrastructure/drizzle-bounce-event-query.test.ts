/**
 * F8 Phase 4 Wave I4 — `drizzle-bounce-event-query` adapter unit tests.
 *
 * Pin the SQL contract: 3 FILTER aggregates, primary-contact email
 * resolution, null-cycle handling. Real Neon integration tests
 * lives in Wave I8 (T109-T112) — these unit tests focus on adapter
 * shape + edge cases via the mocked Drizzle client.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const tenantContext = { slug: 'tenantA' } as { slug: string };

// Module-level mock state — the mocked db / runInTenant capture the
// last-queried tenant + return scripted values per test.
const mockState: {
  primaryEmail: string | null;
  hardBounces: number;
  softInCycle: number;
  soft30d: number;
  primaryEmailQueried: boolean;
  bounceQueried: boolean;
} = {
  primaryEmail: null,
  hardBounces: 0,
  softInCycle: 0,
  soft30d: 0,
  primaryEmailQueried: false,
  bounceQueried: false,
};

vi.mock('@/lib/db', async () => {
  // Mock both `db` (cross-tenant scan) and `runInTenant` (per-tenant
  // primary-contact resolution).
  const mockTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            mockState.primaryEmail
              ? [{ email: mockState.primaryEmail }]
              : [],
        }),
      }),
    }),
  };
  const mockDb = {
    select: () => ({
      from: () => ({
        where: async () => {
          mockState.bounceQueried = true;
          return [
            {
              hardBounces: mockState.hardBounces,
              softInCycle: mockState.softInCycle,
              soft30d: mockState.soft30d,
            },
          ];
        },
      }),
    }),
  };
  return {
    db: mockDb,
    runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => {
      mockState.primaryEmailQueried = true;
      return fn(mockTx);
    },
  };
});

vi.mock('@/lib/env', () => ({
  env: {
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

import { makeDrizzleBounceEventQuery } from '@/modules/renewals/infrastructure/drizzle/drizzle-bounce-event-query';

const MEMBER_ID = '00000000-0000-0000-0000-000000000aaa';
const NOW_ISO = '2026-05-15T12:00:00.000Z';
const CYCLE_STARTED_AT = '2026-05-01T00:00:00.000Z';

function resetState(): void {
  mockState.primaryEmail = null;
  mockState.hardBounces = 0;
  mockState.softInCycle = 0;
  mockState.soft30d = 0;
  mockState.primaryEmailQueried = false;
  mockState.bounceQueried = false;
}

describe('drizzle-bounce-event-query adapter', () => {
  beforeEach(() => {
    resetState();
  });

  it('member with no primary contact: returns zeros (with cycle context)', async () => {
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(result.hardBounces).toBe(0);
    expect(result.softBouncesInCycle).toBe(0);
    expect(result.softBouncesIn30Days).toBe(0);
    // Did NOT query email_delivery_events when primary email is null.
    expect(mockState.bounceQueried).toBe(false);
  });

  it('member with no primary contact + null cycle: softBouncesInCycle is null', async () => {
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: null,
      nowIso: NOW_ISO,
    });
    expect(result.softBouncesInCycle).toBe(null);
  });

  it('member with primary contact + zero bounces: returns zeros', async () => {
    mockState.primaryEmail = 'a@b.co';
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(result.hardBounces).toBe(0);
    expect(result.softBouncesInCycle).toBe(0);
    expect(result.softBouncesIn30Days).toBe(0);
    expect(mockState.bounceQueried).toBe(true);
  });

  it('returns hard bounce count when present', async () => {
    mockState.primaryEmail = 'a@b.co';
    mockState.hardBounces = 1;
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(result.hardBounces).toBe(1);
  });

  it('returns soft bounce counts (in-cycle + 30d) when present', async () => {
    mockState.primaryEmail = 'a@b.co';
    mockState.softInCycle = 3;
    mockState.soft30d = 5;
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(result.softBouncesInCycle).toBe(3);
    expect(result.softBouncesIn30Days).toBe(5);
  });

  it('null cycle short-circuits in-cycle count; 30d still computes', async () => {
    mockState.primaryEmail = 'a@b.co';
    mockState.softInCycle = 999; // would be set if queried
    mockState.soft30d = 4;
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: null,
      nowIso: NOW_ISO,
    });
    expect(result.softBouncesInCycle).toBe(null);
    expect(result.softBouncesIn30Days).toBe(4);
  });

  it('coerces stringified counts (pg driver edge case) to numbers', async () => {
    mockState.primaryEmail = 'a@b.co';
    // Cast as any to force string-typed mock — exercises the
    // `Number(row?.X ?? 0)` defensive coercion in adapter.
    (mockState as unknown as { hardBounces: unknown }).hardBounces = '7';
    (mockState as unknown as { softInCycle: unknown }).softInCycle = '2';
    (mockState as unknown as { soft30d: unknown }).soft30d = '4';
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    const result = await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(result.hardBounces).toBe(7);
    expect(result.softBouncesInCycle).toBe(2);
    expect(result.softBouncesIn30Days).toBe(4);
  });

  it('runs the primary-contact query inside runInTenant scope', async () => {
    mockState.primaryEmail = 'a@b.co';
    const repo = makeDrizzleBounceEventQuery(tenantContext);
    await repo.countBounces('tenantA', MEMBER_ID, {
      cycleStartedAt: CYCLE_STARTED_AT,
      nowIso: NOW_ISO,
    });
    expect(mockState.primaryEmailQueried).toBe(true);
  });
});
