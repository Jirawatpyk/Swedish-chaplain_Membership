/**
 * R3 Batch 4a (R3-C3) — pre-tx repo error containment for
 * `acceptTierUpgrade`.
 *
 * Before R3 Batch 4a, the use-case's `tierUpgradeRepo.findById` +
 * `cyclesRepo.findActiveForMember` ran OUTSIDE the outer try/catch.
 * A DB drop / RLS error / drizzle parse error escaped the Result
 * contract, bubbled past the use-case to the route handler's outer
 * catch, and surfaced as a generic `accept_unexpected_error` with NO
 * `errorId` in the `F8.ACCEPT_TIER.*` taxonomy.
 *
 * This file pins the new contract:
 *   1. `tierUpgradeRepo.findById` throws → `server_error` Result.err
 *      with message prefix `pre-tx-repo-lookup:`
 *   2. `cyclesRepo.findActiveForMember` throws → same
 *   3. Happy-path lookup variants (not_found / not_open /
 *      no_active_cycle) still return their typed errors unchanged
 *
 * Constitution Principle VIII — Result-typed errors must surface
 * through the use-case API, not escape via thrown exceptions.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { acceptTierUpgrade } from '@/modules/renewals/application/use-cases/accept-tier-upgrade';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tenant = asTenantContext('swecham');
const SUGGESTION_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';

function makeMinimalDeps(opts: {
  findByIdResult?: { suggestionId: string; status: string; memberId: string } | null | Error;
  findActiveResult?: { cycleId: string; expiresAt: string } | null | Error;
}): RenewalsDeps {
  const tierUpgradeRepo = {
    findById: vi.fn(async () => {
      const r = opts.findByIdResult;
      if (r instanceof Error) throw r;
      return r === undefined
        ? { suggestionId: SUGGESTION_ID, status: 'open', memberId: 'mem' }
        : r;
    }),
  };
  const cyclesRepo = {
    findActiveForMember: vi.fn(async () => {
      const r = opts.findActiveResult;
      if (r instanceof Error) throw r;
      return r === undefined
        ? {
            cycleId: '33333333-3333-3333-3333-333333333333',
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          }
        : r;
    }),
  };
  return {
    tenant,
    tierUpgradeRepo,
    cyclesRepo,
    clock: { now: () => new Date('2026-05-19T10:00:00Z') },
    // Other deps are not reached in the pre-tx error paths exercised here.
  } as unknown as RenewalsDeps;
}

const validInput = {
  tenantId: 'swecham',
  suggestionId: SUGGESTION_ID,
  actorUserId: ACTOR_ID,
  actorRole: 'admin' as const,
  correlationId: 'cor-1',
};

describe('acceptTierUpgrade — pre-tx repo error containment (R3-C3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('R3-C3: tierUpgradeRepo.findById throws → server_error Result.err (no escape)', async () => {
    const deps = makeMinimalDeps({
      findByIdResult: new Error('connection reset by peer'),
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('server_error');
    if (result.error.kind !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('pre-tx-repo-lookup');
    expect(result.error.message).toContain('connection reset by peer');
  });

  it('R3-C3: cyclesRepo.findActiveForMember throws → server_error Result.err', async () => {
    const deps = makeMinimalDeps({
      findActiveResult: new Error('postgres timeout'),
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('server_error');
    if (result.error.kind !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('pre-tx-repo-lookup');
    expect(result.error.message).toContain('postgres timeout');
  });

  it('happy-path lookup variants still return typed errors (regression guard)', async () => {
    // findById returns null → suggestion_not_found
    const depsA = makeMinimalDeps({ findByIdResult: null });
    const r1 = await acceptTierUpgrade(depsA, validInput);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.error.kind).toBe('suggestion_not_found');

    // findById returns non-open → suggestion_not_open
    const depsB = makeMinimalDeps({
      findByIdResult: {
        suggestionId: SUGGESTION_ID,
        status: 'accepted_pending_apply',
        memberId: 'mem',
      },
    });
    const r2 = await acceptTierUpgrade(depsB, validInput);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.error.kind).toBe('suggestion_not_open');

    // findActiveForMember returns null → no_active_cycle
    const depsC = makeMinimalDeps({ findActiveResult: null });
    const r3 = await acceptTierUpgrade(depsC, validInput);
    expect(r3.ok).toBe(false);
    if (r3.ok) throw new Error('unreachable');
    expect(r3.error.kind).toBe('no_active_cycle');
  });
});
