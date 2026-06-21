/**
 * T046 โ€” Unit tests for `compute-quota-counter.ts` Application use-case.
 *
 * Wave 6 fills the bodies. Tests exercise the derived quota view:
 *   reserved = COUNT(broadcasts WHERE status IN ('submitted','approved') AND member)
 *   used     = COUNT(broadcasts WHERE status='sent' AND quota_year_consumed=year AND member)
 *   cap      = plan.benefit_matrix.eblast_per_year
 *   remaining = cap - used - reserved
 *
 * Strategy: hand-built `BroadcastsRepo.countForMemberQuota` mock + hand-built
 * `PlansBridgePort.getPlanForMember` mock + a fixed clock so quota year
 * is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computeQuotaCounter } from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import { ok, err } from '@/lib/result';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/compute-quota-counter.ts',
);

const tenant: TenantContext = asTenantContext('test-tenant');

interface DepsFixture {
  readonly cap?: number;
  readonly used?: number;
  readonly reserved?: number;
  readonly memberFound?: boolean;
  readonly clockNow?: Date;
}

function makePlansBridge({
  cap = 6,
  memberFound = true,
}: DepsFixture = {}): PlansBridgePort {
  return {
    async getPlanForMember(_ctx, memberId) {
      if (!memberFound) {
        return err({ kind: 'plan_lookup.member_not_found', memberId });
      }
      return ok({
        planId: 'premium-corporate-2026',
        planCode: 'corporate',
        eblastPerYear: cap,
      });
    },
  };
}

function makeBroadcastsRepo({
  used = 0,
  reserved = 0,
}: DepsFixture = {}): BroadcastsRepo {
  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(null);
    },
    async insertDraft() {
      throw new Error('not used');
    },
    async updateDraft() {
      throw new Error('not used');
    },
    async updateDraftFromTemplate() {
      throw new Error('not used in compute-quota-counter fixture');
    },
    async findById() {
      return null;
    },
    async findByIdInTx() {
      return null;
    },
    async lockForUpdate() {
      return null;
    },
    async applyTransition() {
      throw new Error('not used');
    },
    async attachResendIds() {
      // no-op
    },
    async attachAudienceId() {
      // no-op
    },
    async listByTenantStatus() {
      return { rows: [], nextCursor: null };
    },
    async countForMemberQuota() {
      return { submittedOrApproved: reserved, sent: used };
    },
    async findByResendBroadcastIdBypassRls() {
      return null;
    },
    async listForMemberPaginated() {
      return { rows: [], total: 0, totalPages: 0, page: 1 };
    },
    async findOwnedByMember() {
      return { broadcast: null, probeKind: 'not_found' as const };
    },
    async aggregateDeliveryCountsForBroadcast() {
      return { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0 };
    },
    async pruneExpiredDrafts() {
      return { prunedCount: 0 };
    },
    async listInFlightOwnedByMember() { return []; },
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience() { throw new Error('not used in compute-quota-counter fixture'); },
    async markAudienceDeletedInTx() { throw new Error('not used in compute-quota-counter fixture'); },
    async existingBroadcastIds() { throw new Error('not used in compute-quota-counter fixture'); },
  };
}

function makeDeps(opts: DepsFixture = {}) {
  const clockNow = opts.clockNow ?? new Date('2026-06-15T05:00:00Z');
  return {
    tenant,
    plansBridge: makePlansBridge(opts),
    broadcastsRepo: makeBroadcastsRepo(opts),
    clock: { now: () => clockNow },
  };
}

describe('compute-quota-counter โ€” Wave 6 (T067 GREEN)', () => {
  it('use-case module exists at application/use-cases/compute-quota-counter.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- Happy path counters ------------------------------------------

  it('returns {used: 0, reserved: 0, remaining: 6, cap: 6} for never-used Premium member', async () => {
    const deps = makeDeps({ cap: 6, used: 0, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.used).toBe(0);
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.remaining).toBe(6);
      expect(result.value.counter.cap).toBe(6);
    }
  });

  it('returns reserved counts from broadcasts in submitted + approved states', async () => {
    const deps = makeDeps({ cap: 6, used: 0, reserved: 2 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.reserved).toBe(2);
      expect(result.value.counter.remaining).toBe(4);
    }
  });

  it('R4 Tests-Gap#3: AS4 โ€” cancelled broadcast does NOT count toward reserved (quota released)', async () => {
    // Verify-fix R4 (2026-05-02): spec AS4 (line 326) explicitly says
    // "the quota reservation is released" on cancel. The repo SQL
    // (`drizzle-broadcasts-repo.ts:667`) does NOT include 'cancelled'
    // in the reserved-status set โ€” but that contract is invisible
    // unless a test asserts it. Mirrors the failed_to_dispatch
    // assertion from Tests-Gap#1: contract locked at the use-case
    // boundary so a future SQL refactor can't silently break AS4.
    const deps = makeDeps({ cap: 6, used: 0, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // After cancel, the row is in 'cancelled' status which is NOT in
      // the reserved set (excluded from `IN ('submitted', 'approved',
      // 'failed_to_dispatch')`). reserved = 0, full quota available.
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.remaining).toBe(6);
    }
  });

  it('D1 (2026-06-21): failed_to_dispatch RELEASES the reservation slot', async () => {
    // Design spec D1 / FR-003 (2026-06-21): failed_to_dispatch is terminal
    // (no re-trigger route exists), so holding the slot is a permanent
    // lockout. The repo SQL no longer counts failed_to_dispatch as reserved
    // (`IN ('submitted', 'approved')`), so a member whose only broadcast
    // failed to dispatch has the full quota available again. This mocks the
    // repo to return reserved=0 (the post-D1 contract) and asserts the
    // use-case surfaces "remaining quota = cap". Live SQL behaviour locked
    // at the integration layer
    // (`tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts`).
    const deps = makeDeps({ cap: 1, used: 0, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.remaining).toBe(1);
      // Member is FREE to submit again because the failed_to_dispatch
      // row no longer holds the slot (Design D1; spec AS2 amended).
    }
  });

  it('returns used counts from broadcasts in sent state with quota_year_consumed = current year', async () => {
    const deps = makeDeps({ cap: 6, used: 3, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.used).toBe(3);
      expect(result.value.counter.remaining).toBe(3);
    }
  });

  // ---- Quota year boundary ------------------------------------------

  it('quota_year computed via Asia/Bangkok fiscal-year boundary', async () => {
    // 2026-12-31 23:00 UTC = 2027-01-01 06:00 Asia/Bangkok โ’ year 2027
    const deps = makeDeps({
      clockNow: new Date('2026-12-31T23:00:00Z'),
      cap: 6,
    });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quotaYear).toBe(2027);
    }
  });

  it('quota_year boundary: mid-year UTC stays in current calendar year (Asia/Bangkok)', async () => {
    const deps = makeDeps({
      clockNow: new Date('2026-06-15T12:00:00Z'),
      cap: 6,
    });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quotaYear).toBe(2026);
    }
  });

  // ---- Cap derivation -----------------------------------------------

  it('cap derived from plan.benefit_matrix.eblast_per_year via PlansBridgePort', async () => {
    const deps = makeDeps({ cap: 12 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.cap).toBe(12);
    }
  });

  it('returns cap=0 for free-tier members (eblast_per_year=0) โ’ zeroQuota return', async () => {
    const deps = makeDeps({ cap: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.cap).toBe(0);
      expect(result.value.counter.remaining).toBe(0);
      expect(result.value.counter.used).toBe(0);
      expect(result.value.counter.reserved).toBe(0);
    }
  });

  // ---- Edge cases ---------------------------------------------------

  it('handles maximum-utilisation: used=cap, reserved=0, remaining=0', async () => {
    const deps = makeDeps({ cap: 6, used: 6, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.remaining).toBe(0);
    }
  });

  it('handles split utilisation: used=2, reserved=1, remaining=cap-3', async () => {
    const deps = makeDeps({ cap: 6, used: 2, reserved: 1 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.used).toBe(2);
      expect(result.value.counter.reserved).toBe(1);
      expect(result.value.counter.remaining).toBe(3);
    }
  });

  it('over-subscription detected (used + reserved > cap) returns Result error', async () => {
    const deps = makeDeps({ cap: 6, used: 5, reserved: 3 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.invariant_violation');
    }
  });

  // ---- Member-not-found / plan-not-found ----------------------------

  it('returns quota.member_not_found when plansBridge cannot resolve member', async () => {
    const deps = makeDeps({ memberFound: false });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('unknown') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.member_not_found');
    }
  });

  it('Round 4 M4 โ€” non-member_not_found plan error returns ok with zero counter (member exists, plan unresolved)', async () => {
    // Branch coverage: `planLookup.ok=false` AND `error.kind !== 'plan_lookup.member_not_found'`.
    // Source returns ok({zeroCounter, '', '', ...reset}) so the page renders
    // 0/0 remaining without crashing. A regression that flips the condition
    // would silently surface non-zero numbers from a stale plan.
    const tenant = asTenantContext('test-tenant');
    const plansBridge = {
      async getPlanForMember() {
        return err({ kind: 'plan_lookup.unexpected', cause: 'transport down' });
      },
    } as unknown as Parameters<typeof computeQuotaCounter>[0]['plansBridge'];
    const broadcastsRepo = makeBroadcastsRepo();
    const deps = {
      tenant,
      plansBridge,
      broadcastsRepo,
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    };

    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.cap).toBe(0);
      expect(result.value.counter.used).toBe(0);
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.remaining).toBe(0);
      expect(result.value.planCode).toBe('');
      expect(result.value.planId).toBe('');
      // Reset trio still computed so the contract envelope is well-formed.
      expect(result.value.quotaYear).toBe(2026);
      expect(typeof result.value.nextResetAt).toBe('string');
    }
  });
});

// โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€
// `currentQuotaYear` non-Bangkok-tz coverage. Round-4-era warn-path
// for unknown-slug fallback was removed once `getTenantTimezone` was
// migrated from the hard-coded slug map to an env-driven, boot-validated
// IANA value (PR #18 follow-up โ€” single TENANT_TIMEZONE per deployment).
// โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€โ”€
import { currentQuotaYear } from '@/modules/broadcasts';

describe('currentQuotaYear โ€” tenant timezone parameter', () => {
  it('defaults to Asia/Bangkok when tenantTz omitted (legacy callers)', () => {
    // 2026-12-31T20:00Z = 2027-01-01T03:00 ICT โ’ year 2027
    expect(currentQuotaYear(new Date('2026-12-31T20:00:00Z'))).toBe(2027);
  });

  it('threads explicit Asia/Bangkok timezone', () => {
    expect(
      currentQuotaYear(
        new Date('2026-12-31T20:00:00Z'),
        'Asia/Bangkok',
      ),
    ).toBe(2027);
  });

  it('threads explicit Europe/Stockholm โ€” same instant, different year', () => {
    // 2026-12-31T20:00Z = 2026-12-31T21:00 CET (Stockholm) โ’ year 2026
    expect(
      currentQuotaYear(
        new Date('2026-12-31T20:00:00Z'),
        'Europe/Stockholm',
      ),
    ).toBe(2026);
  });

  it('threads explicit UTC', () => {
    expect(
      currentQuotaYear(new Date('2026-12-31T20:00:00Z'), 'UTC'),
    ).toBe(2026);
  });
});
