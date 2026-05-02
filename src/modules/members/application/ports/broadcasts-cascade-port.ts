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

/**
 * Round 3 type-design fix — bounded enum for system-initiated cascade
 * cancellations. Previously this was a free `string` which let any
 * caller stuff arbitrary text into the audit `payload.cancellationReason`
 * forensic field. Audit payloads are the system of record for Principle I
 * forensics; a string-literal union is the right type.
 *
 * - `originator_member_deleted` → F3 archive (default per spec § Edge
 *   Cases L353)
 * - `gdpr_erasure_request`      → GDPR Art. 17 right-to-erasure
 *                                 (compliance-differentiated audit row)
 * - `pdpa_deletion_request`     → PDPA §33 right-to-deletion (Thai
 *                                 equivalent; differentiated for legal
 *                                 reporting in TH locale)
 */
export type SystemCancellationReason =
  | 'originator_member_deleted'
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request';

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
      readonly cancellationReason?: SystemCancellationReason;
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<CascadeResult>;
}

/**
 * Discriminated union over the F3↔F7 cascade outcome (Round 2 review
 * type-design fix — flat record allowed nonsensical states like
 * `{cancelledCount: 5, outcome: 'cascade_failed'}`; Round 5 review fix —
 * added `'cascade_partial_failure'` so per-broadcast unexpected-error
 * failures are surfaced to the F3 caller for audit visibility, not just
 * to the metric pipeline).
 *
 *   - `'ok'`                       → cascade ran end-to-end. Counts may
 *                                    legitimately be 0 when the member had
 *                                    no in-flight broadcasts.
 *   - `'cascade_partial_failure'`  → cascade iterated all broadcasts but
 *                                    one or more rows hit unexpected
 *                                    errors (`unexpectedErrorCount > 0`).
 *                                    Other broadcasts may still have
 *                                    cancelled (`cancelledCount`) or
 *                                    skipped due to concurrent races
 *                                    (`skippedConcurrentCount`). F3
 *                                    archival still commits; a follow-up
 *                                    audit row records which member's
 *                                    cascade was partial so the cleanup
 *                                    runbook can re-attempt cancellation.
 *   - `'cascade_failed'`           → the F7 cascade use-case ITSELF errored
 *                                    before it could iterate broadcasts
 *                                    (e.g. listing query threw). Counts are
 *                                    not surfaced. F3 archival still
 *                                    commits (cascade is best-effort).
 *
 * NOTE: this three-value port-level outcome is deliberately distinct
 * from the three-value `BroadcastsCascadeOutcomeMetric` (per-broadcast
 * label) — see `src/lib/metrics.ts cascadeOutcome` JSDoc. Port = adapter
 * rollup; metric = per-row classification.
 */
export type CascadeResult =
  | {
      readonly outcome: 'ok';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
    }
  | {
      readonly outcome: 'cascade_partial_failure';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
      readonly unexpectedErrorCount: number;
    }
  | { readonly outcome: 'cascade_failed' };
