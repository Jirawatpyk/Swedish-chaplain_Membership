/**
 * F9 US4 (verify-run D1) — `computeBenefitUsage` use-case unit tests.
 *
 * The use-case is pure-of-IO through injected ports, so we exercise every
 * branch with hand-rolled fakes (no module mocking): member_not_found, the
 * `compute_failed` catch, the entitlements-null empty view, and the
 * quantifiable-assembly (eblast + cultural) + active-benefit mapping. The
 * domain math itself is covered by `benefit-usage.test.ts`; here we pin the
 * orchestration + Result branches.
 */
import { describe, expect, it } from 'vitest';
import { computeBenefitUsage } from '@/modules/insights/application/use-cases/compute-benefit-usage';
import type { ComputeBenefitUsageDeps } from '@/modules/insights/application/use-cases/compute-benefit-usage';
import type {
  BenefitConsumption,
  BenefitEntitlements,
  MemberPlanIdentity,
} from '@/modules/insights/application/ports/source-ports';
import type { TenantContext } from '@/modules/tenants';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;
// Mid-2026 ICT → membershipYear 2026, ~ mid-year elapsed.
const CLOCK = { now: () => new Date('2026-07-02T05:00:00.000Z') };

function makeDeps(over: {
  identity?: MemberPlanIdentity | null;
  entitlements?: BenefitEntitlements | null;
  eblast?: BenefitConsumption;
  cultural?: BenefitConsumption;
  throwOn?: 'entitlements' | 'broadcast';
}): ComputeBenefitUsageDeps {
  return {
    memberPlanSource: {
      findPlanIdentity: async () =>
        over.identity === undefined ? { planId: 'corporate', planYear: 2026 } : over.identity,
    },
    planSource: {
      getEntitlements: async () => {
        if (over.throwOn === 'entitlements') throw new Error('neon down');
        return over.entitlements === undefined
          ? { eblastPerYear: 6, culturalTicketsPerYear: 4, activeBenefits: ['directory_listing'] }
          : over.entitlements;
      },
      getPlanLabel: async () => {
        // stub — implemented in 067 T4/T5
        return null;
      },
    },
    broadcastSource: {
      getEblastConsumption: async () => {
        // Simulates the adapter's fail-loud throw when computeQuotaCounter
        // returns !ok (C-1) — must surface as compute_failed, never used:0.
        if (over.throwOn === 'broadcast') throw new Error('eblast consumption lookup failed: quota.member_not_found');
        return over.eblast ?? { used: 2, lastUsedAt: '2026-03-01T00:00:00.000Z' };
      },
    },
    eventSource: {
      getCulturalConsumption: async () => over.cultural ?? { used: 0, lastUsedAt: null },
    },
    clock: CLOCK,
    tenantTimezone: 'Asia/Bangkok',
  };
}

describe('computeBenefitUsage', () => {
  it('member_not_found when the plan identity cannot be resolved', async () => {
    const r = await computeBenefitUsage(CTX, { memberId: 'm1' }, makeDeps({ identity: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('member_not_found');
  });

  it('assembles eblast + cultural quantifiable benefits + active list', async () => {
    const r = await computeBenefitUsage(CTX, { memberId: 'm1' }, makeDeps({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.membershipYear).toBe(2026);
    const eblast = r.value.quantifiable.find((b) => b.key === 'eblast');
    const cultural = r.value.quantifiable.find((b) => b.key === 'cultural_tickets');
    expect(eblast).toMatchObject({ used: 2, entitlement: 6 });
    expect(cultural).toMatchObject({ used: 0, entitlement: 4 });
    expect(r.value.active).toEqual([{ key: 'directory_listing' }]);
  });

  it('entitlements null → empty view (no quantifiable, no active, no warning)', async () => {
    const r = await computeBenefitUsage(CTX, { memberId: 'm1' }, makeDeps({ entitlements: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quantifiable).toHaveLength(0);
    expect(r.value.active).toHaveLength(0);
    expect(r.value.aggregateConsumedPct).toBeNull();
    expect(r.value.underUseWarning).toBe(false);
  });

  it('omits a benefit the plan grants 0 of (eblast 6, cultural 0)', async () => {
    const r = await computeBenefitUsage(
      CTX,
      { memberId: 'm1' },
      makeDeps({
        entitlements: { eblastPerYear: 6, culturalTicketsPerYear: 0, activeBenefits: [] },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quantifiable.map((b) => b.key)).toEqual(['eblast']);
  });

  it('compute_failed (with cause) when a source read throws', async () => {
    const r = await computeBenefitUsage(
      CTX,
      { memberId: 'm1' },
      makeDeps({ throwOn: 'entitlements' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('compute_failed');
    if (r.error.code === 'compute_failed') {
      expect(r.error.cause).toBeInstanceOf(Error);
    }
  });

  it('C-1: a broadcast fail-loud throw surfaces as compute_failed (never a masked used:0)', async () => {
    const r = await computeBenefitUsage(
      CTX,
      { memberId: 'm1' },
      makeDeps({ throwOn: 'broadcast' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('compute_failed');
  });
});
