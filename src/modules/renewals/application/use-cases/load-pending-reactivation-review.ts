/**
 * 070 F8 item #18 — `loadPendingReactivationReview`.
 *
 * Read-only list of cycles awaiting an admin reactivation decision
 * (status `pending_admin_reactivation`). Powers the "Pending review"
 * discovery view on `/admin/renewals` so an admin can FIND these cycles
 * and click through to approve / reject (the approve/reject actions live
 * on the cycle-detail page).
 *
 * Reuses the same `cyclesRepo.list({ statusFilter: [...] })` path the
 * `reconcilePendingReactivations` cron uses — no new repo method. Returns
 * the raw Domain `RenewalCycle` rows (no member company-name join); the
 * Presentation layer batch-enriches company names via F3's
 * `findManyByIdsInTx` to avoid coupling the renewals Domain entity to F3
 * presentation data (cross-context batched-read pattern).
 *
 * Tenant isolation: `cyclesRepo.list` wraps its query in
 * `runInTenant(ctx, …)` (Postgres RLS+FORCE) — this use-case never
 * touches a DB client directly (Constitution Principle I two-layer
 * isolation; Principle III port discipline).
 *
 * No domain error to discriminate — input is server-sourced (no request
 * body), so the Result error channel is `never`. An infrastructure throw
 * PROPAGATES; the page wrapper catches it best-effort and renders a
 * "couldn't load" surface so a renewals-side failure never crashes the
 * pipeline page.
 */
import { ok, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { RenewalCycle } from '../../domain/renewal-cycle';

/** Default page size — chambers have <100 lapsed members (see reconcile cron). */
export const PENDING_REVIEW_DEFAULT_PAGE_SIZE = 200;

export interface LoadPendingReactivationReviewInput {
  readonly tenantId: string;
  readonly pageSize?: number;
}

export interface LoadPendingReactivationReviewOutput {
  readonly cycles: ReadonlyArray<RenewalCycle>;
}

export async function loadPendingReactivationReview(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  input: LoadPendingReactivationReviewInput,
): Promise<Result<LoadPendingReactivationReviewOutput, never>> {
  const page = await deps.cyclesRepo.list(input.tenantId, {
    statusFilter: ['pending_admin_reactivation'],
    pageSize: input.pageSize ?? PENDING_REVIEW_DEFAULT_PAGE_SIZE,
    // Oldest pending first — those closest to the 30-day auto-timeout
    // boundary need attention first (matches the reconcile cron order).
    sort: 'expires_at_asc',
  });
  return ok({ cycles: page.items });
}
