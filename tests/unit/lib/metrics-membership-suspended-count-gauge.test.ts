/**
 * 059-membership-suspension Task 18 — `renewalsMetrics.observeMembershipSuspendedCountGauge`.
 *
 * Mirrors `tests/unit/lib/metrics-cycle-state-gauge.test.ts`'s testing
 * strategy for the sibling `observeCycleStateGauge`: the SQL/route feed site
 * (`src/app/api/cron/renewals/dispatch-coordinator/route.ts`) is a best-effort,
 * non-unit-tested path (smoke-tested only, per that file's own docstring —
 * the OTel callback is exercised end-to-end in production, not in vitest's
 * no-exporter environment). This file instead pins the two things that ARE
 * unit-testable in isolation:
 *
 *   1. The DERIVATION contract — "count of suspended members" means the
 *      number of members whose latest cycle resolves to
 *      `deriveMembershipAccess(cycle, now).access === 'suspended'`, computed
 *      here against a fixture cycle set using the REAL (not reimplemented)
 *      domain predicate — never lapsed/terminated, never full.
 *   2. The gauge accumulator contract — `observeMembershipSuspendedCountGauge`
 *      writes the derived count into the `membership_suspended_count`
 *      gauge's per-tenant Map, inspectable via `__test__readGaugeValues`.
 */
import { describe, expect, it } from 'vitest';
import {
  renewalsMetrics,
  __test__readGaugeValues,
} from '@/lib/metrics';
import { deriveMembershipAccess, type RenewalCycle } from '@/modules/renewals';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = new Date('2026-07-14T00:00:00.000Z');

/** Mirrors tests/unit/renewals/domain/derive-membership-access.test.ts's fixture builder. */
function cycle(over: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't1',
    cycleId: '00000000-0000-0000-0000-000000000001',
    memberId: '00000000-0000-0000-0000-0000000000aa',
    status: 'upcoming',
    periodFrom: PAST,
    periodTo: FUTURE,
    expiresAt: FUTURE,
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: '00000000-0000-0000-0000-0000000000bb',
    frozenPlanPriceThb: '1000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    linkedCreditNoteId: null,
    linkedInvoiceId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    createdAt: PAST,
    updatedAt: PAST,
    closedAt: null,
    closedReason: null,
    enteredPendingAt: null,
    ...over,
  } as RenewalCycle;
}

/** Count of members whose LATEST cycle resolves to access === 'suspended'. */
function countSuspended(cycles: ReadonlyArray<RenewalCycle | null>, now: Date): number {
  return cycles.filter((c) => deriveMembershipAccess(c, now).access === 'suspended').length;
}

describe('renewalsMetrics.observeMembershipSuspendedCountGauge (059-membership-suspension Task 18)', () => {
  const tenantA = `mt-susp-a-${Math.random().toString(36).slice(2, 10)}`;
  const tenantB = `mt-susp-b-${Math.random().toString(36).slice(2, 10)}`;
  const tenantC = `mt-susp-c-${Math.random().toString(36).slice(2, 10)}`;

  it('counts ONLY the cycles whose derived access is suspended — not full, not terminated', () => {
    const cycles: ReadonlyArray<RenewalCycle | null> = [
      // suspended (3):
      cycle({ status: 'awaiting_payment', expiresAt: PAST }),
      cycle({
        status: 'pending_admin_reactivation',
        expiresAt: PAST,
        enteredPendingAt: PAST,
      }),
      cycle({ status: 'upcoming', expiresAt: PAST }), // cron-gap suspended
      // full (2) — must NOT be counted:
      cycle({ status: 'upcoming', expiresAt: FUTURE }),
      cycle({
        status: 'completed',
        expiresAt: PAST,
        closedAt: PAST,
        closedReason: 'paid',
        linkedInvoiceId: 'inv1',
      }),
      // terminated (1) — must NOT be counted:
      cycle({
        status: 'lapsed',
        expiresAt: PAST,
        closedAt: PAST,
        closedReason: 'lapsed',
      }),
      // no cycle at all → full, must NOT be counted:
      null,
    ];

    const count = countSuspended(cycles, NOW);
    expect(count).toBe(3);

    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantA, count);
    const bucket = __test__readGaugeValues('membership_suspended_count');
    expect(bucket).toBeDefined();
    expect(bucket!.get(tenantA)).toBe(3);
  });

  it('zero suspended members is observable — distinguishes "none suspended" from "not observed yet"', () => {
    const cycles: ReadonlyArray<RenewalCycle | null> = [
      cycle({ status: 'upcoming', expiresAt: FUTURE }),
      null,
    ];
    const count = countSuspended(cycles, NOW);
    expect(count).toBe(0);

    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantB, count);
    const bucket = __test__readGaugeValues('membership_suspended_count');
    expect(bucket!.has(tenantB)).toBe(true);
    expect(bucket!.get(tenantB)).toBe(0);
  });

  it('re-observing the same tenant OVERWRITES the prior value (most-recent-wins accumulator)', () => {
    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantC, 5);
    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantC, 2);
    const bucket = __test__readGaugeValues('membership_suspended_count');
    expect(bucket!.get(tenantC)).toBe(2);
  });

  it('multiple tenants accumulate as distinct label series in the same gauge', () => {
    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantA, 3);
    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantB, 0);
    renewalsMetrics.observeMembershipSuspendedCountGauge(tenantC, 2);
    const bucket = __test__readGaugeValues('membership_suspended_count');
    expect(bucket!.get(tenantA)).toBe(3);
    expect(bucket!.get(tenantB)).toBe(0);
    expect(bucket!.get(tenantC)).toBe(2);
  });

  it('safeMetric error-swallow contract — observe() never throws into caller (cron pass must not break)', () => {
    expect(() => {
      renewalsMetrics.observeMembershipSuspendedCountGauge(
        'safemetric-synthetic-susp',
        4,
      );
    }).not.toThrow();
    const bucket = __test__readGaugeValues('membership_suspended_count');
    expect(bucket!.get('safemetric-synthetic-susp')).toBe(4);
  });
});
