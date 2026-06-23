/**
 * F8 renewal benefit-summary wiring — insights-backed
 * `BenefitConsumptionReader` adapter (unit).
 *
 * The adapter is the F8 → F9 bridge that resolves a member's metered
 * benefit consumption for the renewal page by REUSING the F9 insights
 * `computeBenefitUsage` use-case (the same source `/portal/benefits`
 * consumes). It maps the insights `quantifiable` shape onto the F8
 * `BenefitConsumptionEntry` contract:
 *   - `cultural_tickets` → `cultural_ticket`
 *   - `entitlement`      → `quota`
 * and collapses every failure mode (`!r.ok`) to `null` so the use-case
 * renders the neutral "unavailable" fallback rather than a 500.
 *
 * `@/modules/insights` is mocked so this stays a pure mapping test — the
 * real F9 read is exercised end-to-end by the renewals integration
 * suite (`tests/integration/renewals/renewal-summary-benefits.test.ts`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';

const computeBenefitUsageMock = vi.fn();
const makeComputeBenefitUsageDepsMock = vi.fn(() => ({ stub: true }));

vi.mock('@/modules/insights', () => ({
  computeBenefitUsage: (...args: unknown[]) => computeBenefitUsageMock(...args),
  makeComputeBenefitUsageDeps: (...args: unknown[]) =>
    makeComputeBenefitUsageDepsMock(...args),
}));

// Import AFTER the mock is registered (vi.mock is hoisted, but keeping
// the import here documents the dependency order).
import { benefitConsumptionReaderInsights } from '@/modules/renewals/infrastructure/ports-adapters/benefit-consumption-reader-insights';

const TENANT_ID = 'tenant-a';
const MEMBER_ID = '00000000-0000-0000-0000-0000000000aa';

function usage(quantifiable: ReadonlyArray<unknown>) {
  return {
    membershipYear: 2026,
    elapsedYearPct: 50,
    quantifiable,
    active: [],
    aggregateConsumedPct: null,
    gapPct: null,
    underUseWarning: false,
  };
}

describe('benefitConsumptionReaderInsights (F8 → F9 mapping)', () => {
  beforeEach(() => {
    computeBenefitUsageMock.mockReset();
    makeComputeBenefitUsageDepsMock.mockClear();
  });

  it('maps quantifiable entries: cultural_tickets→cultural_ticket, entitlement→quota', async () => {
    computeBenefitUsageMock.mockResolvedValueOnce(
      ok(
        usage([
          { key: 'eblast', used: 2, entitlement: 6, lastUsedAt: null },
          { key: 'cultural_tickets', used: 1, entitlement: 4, lastUsedAt: null },
        ]),
      ),
    );
    const result = await benefitConsumptionReaderInsights.read(
      TENANT_ID,
      MEMBER_ID,
    );
    expect(result).toEqual([
      { key: 'eblast', used: 2, quota: 6 },
      { key: 'cultural_ticket', used: 1, quota: 4 },
    ]);
    // The use-case is invoked with the member id + the per-tenant deps.
    expect(computeBenefitUsageMock).toHaveBeenCalledTimes(1);
    const callArgs = computeBenefitUsageMock.mock.calls[0];
    expect(callArgs?.[1]).toEqual({ memberId: MEMBER_ID });
    expect(makeComputeBenefitUsageDepsMock).toHaveBeenCalledWith(TENANT_ID);
  });

  it('empty quantifiable → empty array (available, nothing metered)', async () => {
    computeBenefitUsageMock.mockResolvedValueOnce(ok(usage([])));
    const result = await benefitConsumptionReaderInsights.read(
      TENANT_ID,
      MEMBER_ID,
    );
    expect(result).toEqual([]);
  });

  it('member_not_found → null', async () => {
    computeBenefitUsageMock.mockResolvedValueOnce(
      err({ code: 'member_not_found' }),
    );
    const result = await benefitConsumptionReaderInsights.read(
      TENANT_ID,
      MEMBER_ID,
    );
    expect(result).toBeNull();
  });

  it('compute_failed → null', async () => {
    computeBenefitUsageMock.mockResolvedValueOnce(
      err({ code: 'compute_failed' }),
    );
    const result = await benefitConsumptionReaderInsights.read(
      TENANT_ID,
      MEMBER_ID,
    );
    expect(result).toBeNull();
  });
});
