/**
 * Pure presentation helpers for the F7 US3 broadcast quota surface.
 *
 * Spec authority: spec.md US3 AS1, AS2, AS4 + contracts/broadcasts-api.md
 * § 1.7 (`nextResetAt` + `tenantTimezone`).
 *
 * Lives under `@/components/broadcast/` (a neutral home) so its live
 * cross-route consumers — the Benefits-page `BroadcastsPanel` and the
 * broadcast detail page — share a single import surface without reaching
 * into another route segment's private `_helpers` folder. (Relocated from
 * `(member)/portal/benefits/e-blasts/_helpers/` after that route became a
 * thin redirect; 058 G1.)
 *
 * Tested by tests/unit/broadcasts/benefits-page-helpers.test.ts (T128, 14
 * cases). Kept Domain-pure (no React, no Drizzle, no fetch) so the page
 * server-component can stay thin and the tz / pagination math is
 * deterministic.
 */
import { Instant, ZonedDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import type { IanaTimezone } from '@/modules/tenants';
import { nextResetAtFor } from '@/modules/broadcasts';

/**
 * Re-export of the canonical quota-reset formatter so the page helper
 * stays the single import surface for the benefits page. The actual
 * js-joda math lives in the Application use-case (single source of
 * truth for the API contract field `nextResetAt` AND the AS1 microcopy).
 */
export const formatNextResetAt = nextResetAtFor;

/**
 * AS2 explainer-microcopy gate.
 *
 * True iff the member's most-recent plan change happened *inside* the
 * current quota year, calculated against the tenant calendar year. The
 * absolute calendar threshold uses `tenantTz` so a Bangkok member who
 * upgraded at 2025-12-31 23:00 UTC (= 2026-01-01 06:00 ICT) is treated
 * as a 2026 quota-year change.
 */
export function shouldShowPlanChangedExplainer(
  planChangedAt: Date | null,
  quotaYear: number,
  tenantTz: IanaTimezone | string,
): boolean {
  if (planChangedAt === null) return false;
  const zone = ZoneId.of(tenantTz);
  const yearAtChange = ZonedDateTime.ofInstant(
    Instant.ofEpochMilli(planChangedAt.getTime()),
    zone,
  ).year();
  return yearAtChange === quotaYear;
}

export interface HistoryPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly total: number;
}

/**
 * In-memory paginator for the broadcast-history table.
 *
 * Centralised so the page server-component, the test fixture and any
 * future client-side virtualisation share one canonical clamping rule:
 *   - `page < 1`   → clamp to 1.
 *   - `page > N`   → clamp to last page (where N = totalPages).
 *   - empty input  → 0 totalPages, page = 1, items = [].
 *   - `perPage<1`  → throw (caller bug, surface loudly).
 */
export function paginateHistory<T>(
  rows: ReadonlyArray<T>,
  page: number,
  perPage: number,
): HistoryPage<T> {
  if (perPage < 1) {
    throw new RangeError(`paginateHistory: perPage must be >= 1, got ${perPage}`);
  }
  const total = rows.length;
  if (total === 0) {
    return { items: [], page: 1, perPage, totalPages: 0, total: 0 };
  }
  const totalPages = Math.ceil(total / perPage);
  const clamped = Math.max(1, Math.min(page, totalPages));
  const start = (clamped - 1) * perPage;
  const items = rows.slice(start, start + perPage);
  return { items, page: clamped, perPage, totalPages, total };
}
