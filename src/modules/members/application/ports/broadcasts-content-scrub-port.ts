/**
 * Application port — F7 broadcasts CONTENT redaction for the member-erasure
 * cascade (COMP-1 US2b, GDPR Art. 17 / PDPA §33). The `broadcast_deliveries`
 * tombstone is NOT part of this port (it moved into `eraseMember`'s atomic
 * scrub tx — see the note below).
 *
 * Redacts the PII a member authored into F7 broadcasts: scrubs every
 * broadcast the member ORIGINATED (subject/body_html/body_source/from_name/
 * reply_to_email → `'[redacted]'`, custom_recipient_emails → sentinel/NULL,
 * and the nullable reason columns rejection_reason/cancellation_reason/
 * failure_reason → NULL). Wired into `erase-member` as a POST-COMMIT
 * best-effort cascade.
 *
 * The `broadcast_deliveries` tombstone is NO LONGER part of this port (the
 * 2026-06-18 2nd /code-review HIGH fix): it moved into `eraseMember`'s atomic
 * scrub tx (`BroadcastsDeliveryTombstonePort`) so it co-commits with
 * `erased_at` and survives a first-pass failure of this content scrub. The
 * caller passes the `tombstonedCount` that atomic step already produced so
 * the single `broadcast_content_redacted` audit still records both counts.
 *
 * Cross-module note: broadcasts live in F7 (`broadcasts/application`).
 * The adapter is the single allowed crossing point for F3 use-cases;
 * Application-layer callers depend only on this port. The adapter calls
 * F7's barrel export `scrubBroadcastContentForMember`. This file (members
 * Application layer) imports ZERO F7 symbols — only the F3 `MemberId`
 * domain type + the cross-cutting `TenantContext`.
 *
 * Tx semantics: F7's scrub use-case opens its OWN transaction
 * (`broadcastsRepo.withTx`) so the content scrub + audit emit co-commit. The
 * F3 caller does NOT pass its own tx — the cascade runs after the member-row
 * mutation has committed, mirroring the F7 cancel cascade
 * (`BroadcastsCascadePort`).
 *
 * Outcome contract: best-effort. `'ok'` → the scrub ran end-to-end
 * (counts may be 0 when the member authored/received nothing). `'failed'`
 * → the F7 use-case returned an error OR threw; the F3 caller flips its
 * cascade-completion flag so the erasure proof records the cascade as
 * incomplete (no swallow-to-no-op). Counts are present only on `'ok'`.
 */
import type { MemberId } from '../../domain/member';
import type { TenantContext } from '@/modules/tenants';

/**
 * Bounded erasure-reason enum carried into the F7
 * `broadcast_content_redacted` audit `payload.reason` so the forensic
 * trail records the real legal basis (GDPR Art. 17 vs PDPA §33) instead
 * of the F7 use-case's archival default `'originator_member_deleted'`.
 *
 * This is the strict erasure SUBSET of `SystemCancellationReason` (the
 * archive cascade port) — `erase-member` only ever carries one of these
 * two values (`eraseMemberSchema.reason`), never the archival default.
 * Because it is a subset of the F7 use-case's `ScrubContentReason`
 * (`'originator_member_deleted' | 'gdpr_erasure_request' |
 * 'pdpa_deletion_request'`), the adapter can thread `meta.reason`
 * straight into the use-case input with no widening.
 *
 * Kept hand-declared (NOT derived as `EraseMemberInput['reason']`) on
 * purpose: this is an Application-layer PORT, and deriving would make the
 * port import the `erase-member` use-case, inverting the natural dependency
 * direction (use-cases depend on ports, not vice versa). The value coupling
 * is instead enforced structurally by a compile-time `extends` assertion in
 * `erase-member.test.ts` (the S2 type-design fix), which fails the build if
 * this union ever drifts from `EraseMemberInput['reason']`.
 */
export type MemberErasureReason =
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request';

export interface BroadcastsContentScrubPort {
  /**
   * Scrub the F7 content the member authored. Idempotent — a replay
   * re-scrubs already-`'[redacted]'` rows to the same value.
   *
   * `meta.initiatedByUserId` records the F3 admin who initiated the
   * erasure (carried into the F7 `broadcast_content_redacted` audit row).
   * `meta.requestId` threads the forensic request id. `meta.reason`
   * records the legal basis (Art. 17 vs PDPA §33) on the audit row — the
   * erasure caller always carries it (`eraseMemberSchema.reason`), so it
   * is required rather than defaulted to the F7 archival reason.
   *
   * `meta.tombstonedCount` is the number of `broadcast_deliveries` rows the
   * caller ALREADY tombstoned inside its atomic members-scrub tx (the
   * delivery tombstone moved out of this post-commit step in the 2026-06-18
   * 2nd /code-review fix). It is threaded into the single
   * `broadcast_content_redacted` audit so that one row records BOTH the
   * content-scrub count and the delivery-tombstone count (no audit split).
   * This port does NOT tombstone deliveries.
   *
   * Returns `outcome: 'ok'` with the scrubbed/tombstoned counts on
   * success (the tombstoned count is echoed back from `meta`), or
   * `outcome: 'failed'` (no counts) when the F7 use-case errored or threw —
   * the adapter never propagates the throw.
   *
   * The return is a DISCRIMINATED UNION on `outcome` so the counts-present-
   * IFF-ok invariant is enforced by the compiler: the `'ok'` variant REQUIRES
   * both counts, and the `'failed'` variant forbids them. An illegal
   * `{ outcome: 'ok' }` (no counts) can no longer compile — the consumer
   * (`erase-member`) narrows on `outcome` before reading the counts.
   */
  scrubContentForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: {
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
      readonly reason: MemberErasureReason;
      readonly tombstonedCount: number;
    },
  ): Promise<
    | {
        readonly outcome: 'ok';
        readonly scrubbedCount: number;
        readonly tombstonedCount: number;
      }
    | { readonly outcome: 'failed' }
  >;
}
