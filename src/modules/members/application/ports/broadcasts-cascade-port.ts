/**
 * Application port — F7 broadcasts cascade for member lifecycle events.
 *
 * Auto-cancels in-flight broadcasts (status IN ('submitted', 'approved'))
 * owned by an archived/erased member. Used by `archive-member` and
 * future `erase-member` (F9 GDPR Art. 17) use-cases. Spec § Edge Cases
 * L353 / Coverage Gap C2 from `/speckit.analyze` (F7 T178a).
 *
 * Cross-module note: broadcasts live in F7 (`broadcasts/application`).
 * The adapter is the single allowed crossing point for F3 use-cases;
 * Application-layer callers depend only on this port. Adapter calls
 * F7's barrel export `cancelInFlightBroadcastsForMember`.
 *
 * Tx semantics: F7's cascade use-case opens its own short transaction
 * per broadcast (each cancel is independent — a single concurrent
 * race does not roll back the whole cascade). The F3 caller does NOT
 * pass its own tx because F7 holds row-level locks on different rows
 * (`broadcasts` table) and the F3 archival tx is short-lived.
 */
import type { MemberId } from '../../domain/member';
import type { TenantContext } from '@/modules/tenants';

export interface BroadcastsCascadePort {
  /**
   * Cancel every in-flight broadcast owned by `memberId`. Idempotent
   * — replays return `{cancelledCount: 0}` once cascade has run.
   *
   * `cancellationReason` defaults to `'originator_member_deleted'`
   * (matches the spec wording at L353); F3 callers may pass a more
   * specific string (e.g. `'gdpr_erasure_request'`) for compliance
   * differentiation in the F7 audit trail.
   *
   * `initiatedByUserId` records the F3 admin who initiated the
   * archive/erasure. Audit `payload.initiatedByUserId` carries it for
   * forensic linkage; the `broadcasts.cancelled_by_user_id` column
   * remains NULL because the cancel itself is system-initiated
   * (member is the subject, not the actor).
   *
   * Returns the count of broadcasts cancelled + count skipped due to
   * concurrent dispatch worker race (skipped broadcasts deliver
   * normally — the archive happened after the dispatch decision).
   */
  cancelInFlightForMember(
    tenant: TenantContext,
    memberId: MemberId,
    opts: {
      readonly cancellationReason?: string;
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<{
    readonly cancelledCount: number;
    readonly skippedConcurrentCount: number;
    /**
     * `'ok'`              — cascade ran (counts may legitimately be 0
     *                       when the member had no in-flight broadcasts).
     * `'cascade_failed'`  — the F7 cascade itself errored before it
     *                       could observe any broadcasts. Counts are
     *                       always 0 in this branch. F3 archival is
     *                       still allowed to commit (cascade is
     *                       best-effort), but ops dashboards must
     *                       distinguish this from the no-in-flight case.
     */
    readonly outcome: 'ok' | 'cascade_failed';
  }>;
}
