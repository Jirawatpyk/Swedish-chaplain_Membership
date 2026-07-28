/**
 * DV-Wave2 ⑤ — single source of truth for "is this cycle mark-paid-able".
 *
 * Extracted from `cycle-admin-actions.tsx` (was module-private
 * `PAYABLE_STATUSES`) so the pipeline ROW action (`pipeline-table.tsx`) and
 * the cycle-detail control share ONE predicate and can never diverge from
 * the route's state-machine guard. The route
 * (`/api/admin/renewals/[cycleId]/mark-paid-offline`) stays the authority —
 * this gate only decides whether to OFFER the affordance, matching the
 * route so we never present a control the API will 409
 * (`cycle_not_payable`).
 */
import type { CycleStatus } from '@/modules/renewals/client';

/** Statuses where Mark-paid-offline is offered — mirrors the route guard. */
export const PAYABLE_STATUSES: ReadonlySet<CycleStatus> = new Set<CycleStatus>([
  'upcoming',
  'awaiting_payment',
]);

export function shouldOfferMarkPaid(status: CycleStatus): boolean {
  return PAYABLE_STATUSES.has(status);
}
