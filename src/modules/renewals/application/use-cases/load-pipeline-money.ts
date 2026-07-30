/**
 * DV-Wave2 ⑥ — `loadPipelineMoney` use-case.
 *
 * Assembles the `/admin/renewals` THB money KPI band from two reads:
 *   1. `cyclesRepo.loadPipelineMoneyRaw` — RAW per-cohort legs over F4
 *      `invoices` (FY-cohort + BKK boundaries derived in SQL from `nowIso`).
 *   2. `waivedRefundTotals.sumWaivedByInvoice` — the cross-module F5 §105/void
 *      waived-refund map (`Map<invoiceId, satang>`).
 *
 * The waived netting can only be applied PER-INVOICE here (not in the repo's
 * SQL): the `refunds` table lives in the F5 payments module and joining it
 * from renewals would be a cross-module deep import (Constitution Principle
 * III). So the repo returns per-invoice rows and this use-case subtracts the
 * waived amount per row, clamping ≥0 — the F9 `netBalanceSatang` (gross /
 * VAT-inclusive) basis, NOT the ex-VAT `netPaidRevenueSatang`.
 */
import { ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { PipelineMoneySummary } from '../ports/renewal-cycle-repo';

export const loadPipelineMoneyInputSchema = z.object({
  tenantId: z.string().min(1),
  // Fix round 2 #7 — relaxed from `z.string().datetime()` (strict RFC3339,
  // rejects a bare `YYYY-MM-DD`) to a `Date.parse` refinement so this schema
  // accepts EXACTLY the same `nowIso` shapes the `/admin/renewals` page's own
  // gate accepts (`page.tsx` validates with `!Number.isNaN(Date.parse(v))`,
  // not `.datetime()`). Without this, a hand-crafted date-only `?nowIso=
  // 2026-07-15` would pass the page's gate but fail THIS schema, silently
  // degrading the money band to nothing (the best-effort catch in
  // `PipelineMoneyBandSection` swallows the `invalid_input` error).
  nowIso: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'nowIso must be a value Date.parse() can parse',
  }),
  windowDays: z.number().int().min(1).max(365).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});
export type LoadPipelineMoneyInput = z.infer<typeof loadPipelineMoneyInputSchema>;

export type LoadPipelineMoneyError = {
  readonly kind: 'invalid_input';
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
};

/**
 * Per-invoice net: `total − credited − waived`, clamped ≥0, summed over the
 * leg's rows (F9 `netBalanceSatang` basis). The waived map is tenant-wide, so
 * intersecting it by the leg's own invoiceIds is load-bearing — subtracting
 * `Σ(whole map)` would wrongly net waived refunds for invoices OUTSIDE this
 * cohort (event invoices, void invoices, not-yet-due invoices).
 */
const netLeg = (
  rows: ReadonlyArray<{ readonly invoiceId: string; readonly netOfCreditSatang: bigint }>,
  waived: ReadonlyMap<string, bigint>,
): bigint =>
  rows.reduce((acc, r) => {
    const net = r.netOfCreditSatang - (waived.get(r.invoiceId) ?? 0n);
    return acc + (net > 0n ? net : 0n);
  }, 0n);

export async function loadPipelineMoney(
  deps: Pick<RenewalsDeps, 'cyclesRepo' | 'waivedRefundTotals'>,
  rawInput: LoadPipelineMoneyInput,
): Promise<Result<PipelineMoneySummary, LoadPipelineMoneyError>> {
  const parsed = loadPipelineMoneyInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_input',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    };
  }
  const { tenantId, nowIso } = parsed.data;
  const windowDays = parsed.data.windowDays ?? 90;
  // Defaults to 1 (SweCham). A non-January-FY tenant onboarding must resolve
  // the real value from tenant settings at the composition layer and pass it
  // in — kept as an opt (not read inside the SQL) so the aggregate stays
  // deterministic for the pinned-nowIso integration test.
  const fiscalYearStartMonth = parsed.data.fiscalYearStartMonth ?? 1;

  const raw = await deps.cyclesRepo.loadPipelineMoneyRaw(tenantId, {
    nowIso,
    windowDays,
    fiscalYearStartMonth,
  });
  const waived = await deps.waivedRefundTotals.sumWaivedByInvoice(tenantId);

  return ok({
    settledDueToDateSatang: netLeg(raw.settledRows, waived),
    overdueSatang: raw.overdueSatang,
    collectedThisPeriodSatang: netLeg(raw.collectedRows, waived),
    dueSoonSatang: raw.dueSoonSatang,
    // renewals-overdue-prior-fy-subline — pure pass-through, mirroring
    // `overdueSatang`: an unpaid `issued` invoice can never be credited and
    // has no succeeded payment (so no §105/void waived refund) → no
    // credit/waived netting applies to the prior-FY scalar pair either.
    overdueBeforeFySatang: raw.overdueBeforeFySatang,
    overdueBeforeFyCount: raw.overdueBeforeFyCount,
    // Task 3 — the SQL leg's own fiscal-year boundary, threaded through so
    // the band's drill-down `?dueBefore=` provably matches the cohort.
    fyStartDate: raw.fyStartDate,
  });
}
