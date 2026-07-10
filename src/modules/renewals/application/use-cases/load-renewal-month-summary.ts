/**
 * Renewals-by-month — `loadRenewalMonthSummary`.
 *
 * Thin orchestration over `cyclesRepo.countCyclesByExpiryMonth` (which runs
 * the RLS-scoped aggregation inside one `runInTenant` block) → the pure
 * `buildRenewalMonthSummary` view-model. Input is server-sourced (no request
 * body) so the Result error channel is `never`.
 *
 * An infrastructure throw PROPAGATES — this use-case does NOT catch (mirrors
 * `loadMembersWithoutCycle`). The page/section wrapper try/catches best-effort
 * and renders a "couldn't load" card, so a renewals-side failure never crashes
 * the pipeline page. Empty (all buckets 0) is a distinct non-error render.
 *
 * Tenant isolation: the repo threads `tx` from `runInTenant`; this use-case
 * never touches a DB client directly (Constitution Principle I + III).
 */
import { ok, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  buildRenewalMonthSummary,
  type RenewalMonthSummary,
} from '../../domain/renewal-month-bucket';

export interface LoadRenewalMonthSummaryInput {
  readonly tenantId: string;
  /** ISO instant anchoring the BKK 12-month window (page-level, shared with the pipeline month filter). */
  readonly nowIso: string;
}

export async function loadRenewalMonthSummary(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  input: LoadRenewalMonthSummaryInput,
): Promise<Result<RenewalMonthSummary, never>> {
  const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(input.tenantId, {
    nowIso: input.nowIso,
    timezone: 'Asia/Bangkok',
  });
  return ok(buildRenewalMonthSummary(agg, input.nowIso));
}
