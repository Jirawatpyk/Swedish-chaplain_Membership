/**
 * `loadPipelineMoney` — renewals-overdue-prior-fy-subline pass-through.
 *
 * Pins that the prior-FY scalar pair (`overdueBeforeFySatang` +
 * `overdueBeforeFyCount`) flows from `loadPipelineMoneyRaw` into the
 * summary UNTOUCHED — no credit/§105-waived netting is ever applied to it
 * (an unpaid `issued` invoice can never be credited and has no succeeded
 * payment, mirroring the existing `overdueSatang` argument), while the
 * settled leg in the SAME call IS netted per-invoice. A future "run every
 * leg through `netLeg`" refactor would break this test.
 *
 * Repo/DB behaviour of the underlying SQL FILTER legs is covered by the
 * live-Neon test (`tests/integration/renewals/load-pipeline-money.test.ts`);
 * this file only exercises the use-case seam with stub deps. Types for the
 * stubs are DERIVED from `loadPipelineMoney`'s own signature (no deep import
 * of the non-barrel-exported `PipelineMoneyRaw`), so a raw-shape change
 * fails typecheck here too.
 */
import { describe, expect, it } from 'vitest';
import { loadPipelineMoney } from '@/modules/renewals';

type Deps = Parameters<typeof loadPipelineMoney>[0];
type Raw = Awaited<ReturnType<Deps['cyclesRepo']['loadPipelineMoneyRaw']>>;

const raw: Raw = {
  overdueSatang: 50000n,
  dueSoonSatang: 30000n,
  overdueBeforeFySatang: 3852000n, // the real prod case: ฿38,520 due Aug 2025
  overdueBeforeFyCount: 2,
  fyStartDate: '2026-01-01',
  settledRows: [{ invoiceId: 'inv-settled', netOfCreditSatang: 70000n }],
  collectedRows: [],
};

const deps: Deps = {
  // Only `loadPipelineMoneyRaw` is exercised by this use-case; the full
  // RenewalCycleRepo surface is irrelevant here (same single-method-stub
  // trade-off the schema unit test makes by not touching the repo at all).
  cyclesRepo: {
    loadPipelineMoneyRaw: async () => raw,
  } as unknown as Deps['cyclesRepo'],
  waivedRefundTotals: {
    // Waives part of the settled invoice — proves netting DOES run in this
    // call — and names a fictitious prior-FY invoice id that must be a
    // no-op (the prior-FY pair is scalar; nothing to intersect).
    sumWaivedByInvoice: async () =>
      new Map<string, bigint>([
        ['inv-settled', 20000n],
        ['inv-prior-fy', 999999n],
      ]),
  },
};

describe('loadPipelineMoney — prior-FY pair pass-through', () => {
  it('passes overdueBeforeFySatang/Count through raw, un-netted, while netting the settled leg in the same call', async () => {
    const res = await loadPipelineMoney(deps, {
      tenantId: 'tenant-a',
      nowIso: '2026-07-15T03:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Prior-FY pair: exact raw values, immune to the waived map.
    expect(res.value.overdueBeforeFySatang).toBe(3852000n);
    expect(res.value.overdueBeforeFyCount).toBe(2);

    // Control: the settled leg in the SAME result WAS netted (70000 − 20000),
    // so "un-netted above" is a real distinction, not a vacuous one.
    expect(res.value.settledDueToDateSatang).toBe(50000n);

    // The other scalar legs stay pass-through as before.
    expect(res.value.overdueSatang).toBe(50000n);
    expect(res.value.dueSoonSatang).toBe(30000n);

    // Task 3 — the SQL leg's fiscal-year boundary rides through untouched
    // (the band builds its `?dueBefore=` drill-down from it).
    expect(res.value.fyStartDate).toBe('2026-01-01');
  });
});
