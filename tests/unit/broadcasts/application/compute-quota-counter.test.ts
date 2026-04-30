/**
 * T046 — Unit tests for `compute-quota-counter.ts` Application use-case.
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

describe('compute-quota-counter — Wave 6 (T067 GREEN)', () => {
  it('use-case module exists at application/use-cases/compute-quota-counter.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- Happy path counters ------------------------------------------

  it('returns {used: 0, reserved: 0, remaining: 6, cap: 6} for never-used Premium member', async () => {
    const deps = makeDeps({ cap: 6, used: 0, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
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
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.reserved).toBe(2);
      expect(result.value.counter.remaining).toBe(4);
    }
  });

  it('returns used counts from broadcasts in sent state with quota_year_consumed = current year', async () => {
    const deps = makeDeps({ cap: 6, used: 3, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.used).toBe(3);
      expect(result.value.counter.remaining).toBe(3);
    }
  });

  // ---- Quota year boundary ------------------------------------------

  it('quota_year computed via Asia/Bangkok fiscal-year boundary', async () => {
    // 2026-12-31 23:00 UTC = 2027-01-01 06:00 Asia/Bangkok → year 2027
    const deps = makeDeps({
      clockNow: new Date('2026-12-31T23:00:00Z'),
      cap: 6,
    });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
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
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quotaYear).toBe(2026);
    }
  });

  // ---- Cap derivation -----------------------------------------------

  it('cap derived from plan.benefit_matrix.eblast_per_year via PlansBridgePort', async () => {
    const deps = makeDeps({ cap: 12 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.cap).toBe(12);
    }
  });

  it('returns cap=0 for free-tier members (eblast_per_year=0) → zeroQuota return', async () => {
    const deps = makeDeps({ cap: 0 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
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
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.remaining).toBe(0);
    }
  });

  it('handles split utilisation: used=2, reserved=1, remaining=cap-3', async () => {
    const deps = makeDeps({ cap: 6, used: 2, reserved: 1 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.used).toBe(2);
      expect(result.value.counter.reserved).toBe(1);
      expect(result.value.counter.remaining).toBe(3);
    }
  });

  it('over-subscription detected (used + reserved > cap) returns Result error', async () => {
    const deps = makeDeps({ cap: 6, used: 5, reserved: 3 });
    const result = await computeQuotaCounter(deps, { memberId: 'm-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.invariant_violation');
    }
  });

  // ---- Member-not-found / plan-not-found ----------------------------

  it('returns quota.member_not_found when plansBridge cannot resolve member', async () => {
    const deps = makeDeps({ memberFound: false });
    const result = await computeQuotaCounter(deps, { memberId: 'unknown' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.member_not_found');
    }
  });
});
