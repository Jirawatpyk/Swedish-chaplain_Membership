/**
 * Application port — F8 renewals cascade for member lifecycle events.
 *
 * Auto-cancels in-flight renewal cycles owned by an archived/erased
 * member. Used by `archive-member` and future `erase-member` (F9 GDPR
 * Art. 17) use-cases. Mirrors `BroadcastsCascadePort` shape for
 * consistency — chamber DPO compliance reports filter on the same
 * `SystemCancellationReason` union across F7 + F8.
 *
 * Cross-module note: renewal cycles live in F8 (`renewals/application`).
 * The adapter is the single allowed crossing point for F3 use-cases;
 * Application-layer callers depend only on this port. Adapter calls
 * F8's barrel export `cancelInFlightCyclesForMember`.
 *
 * Tx semantics: F8's cascade use-case opens its own short transaction
 * inside `runInTenant` per cycle (per-cycle row lock; concurrent races
 * on individual cycles do not roll back the whole F3 archive). The F3
 * caller does NOT pass its own tx — F3 archival commits first, then
 * the cascade runs as a follow-up best-effort step (mirrors F7
 * pattern at `archive-member.ts:228`).
 */
import type { MemberId } from '../../domain/member';
import type { TenantContext } from '@/modules/tenants';
import type { SystemCancellationReason } from './broadcasts-cascade-port';

// Re-export the F7 union so a single SystemCancellationReason type
// flows across both cascades — chamber legal reports filter on one
// canonical enum, not two parallel-but-divergent ones.
export type { SystemCancellationReason } from './broadcasts-cascade-port';

export interface RenewalsCascadePort {
  /**
   * Cancel every in-flight renewal cycle owned by `memberId`.
   * Idempotent — replays return `{cancelledCount: 0}` once cascade has
   * run.
   *
   * `cancellationReason` is OPTIONAL at the port level (no default).
   * When omitted, the F8 adapter (`f8RenewalsCascadeAdapter` at
   * `infrastructure/adapters/renewals-cascade-adapter.ts`) records
   * the audit `payload.reason` as `'originator_member_archived'`
   * (F8's internal vocabulary — distinct from F7's
   * `'originator_member_deleted'` because F8 cascades only fire
   * from archive in MVP, not hard-delete). F3 callers may pass an
   * explicit `SystemCancellationReason` value (e.g.
   * `'gdpr_erasure_request'`) for compliance differentiation; the
   * adapter maps the F7-canonical enum into the F8 reason space
   * via `toF8Reason()`.
   *
   * `initiatedByUserId` records the F3 admin who initiated the
   * archive/erasure. Audit `actor_user_id` carries it for forensic
   * linkage; the F8 audit `actor_role` is `'system'` because the
   * cascade itself is system-initiated (the member is the subject,
   * not the actor).
   *
   * Returns the count of cycles cancelled + count skipped due to a
   * concurrent admin cancel that won the race.
   */
  cancelInFlightForMember(
    tenant: TenantContext,
    memberId: MemberId,
    opts: {
      readonly cancellationReason?: SystemCancellationReason;
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<RenewalsCascadeResult>;
}

/**
 * Discriminated union over the F3 ↔ F8 cascade outcome. Mirrors F7's
 * `CascadeResult` shape exactly — F3 caller branches symmetrically on
 * both port outcomes for partial-failure logging + cleanup runbook
 * reconciliation.
 *
 *   - `'ok'`                       → cascade ran end-to-end. Counts may
 *                                    legitimately be 0 when the member
 *                                    had no in-flight cycle (idempotent
 *                                    replay).
 *   - `'cascade_partial_failure'`  → cascade started but a concurrent
 *                                    admin cancel won the race for the
 *                                    cycle. F3 archival still commits;
 *                                    a follow-up audit row records the
 *                                    outcome so cleanup runbook can
 *                                    re-attempt cancellation.
 *   - `'cascade_failed'`           → the F8 cascade use-case ITSELF
 *                                    errored before it could iterate
 *                                    (e.g. lookup query threw). Counts
 *                                    are not surfaced. F3 archival
 *                                    still commits (cascade is best-
 *                                    effort).
 */
export type RenewalsCascadeResult =
  | {
      readonly outcome: 'ok';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
    }
  | {
      readonly outcome: 'cascade_partial_failure';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
    }
  | { readonly outcome: 'cascade_failed' };
