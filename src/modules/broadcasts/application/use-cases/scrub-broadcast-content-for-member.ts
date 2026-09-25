/**
 * COMP-1 US2b — GDPR Art. 17 / PDPA §33 F7 broadcast CONTENT redaction.
 * (CONTENT-only — the delivery tombstone moved out; see "DELIVERY TOMBSTONE
 * moved out" below.)
 *
 * Invoked by the F3 member-erasure cascade (via the members module's
 * `BroadcastsContentScrubPort` adapter) AFTER the member row mutation
 * commits, as a post-commit best-effort cascade. Redacts the PII a
 * member authored into F7 broadcasts:
 *
 *   1. `scrubContentForMemberInTx` — on EVERY broadcast the member
 *      originated (every status, including `draft`), redacts
 *      `subject`/`body_html`/`body_source`/`from_name`/`reply_to_email`
 *      → `'[redacted]'`, `custom_recipient_emails` → `['[redacted]']`
 *      (custom rows) / NULL otherwise, and the nullable reason columns
 *      `rejection_reason`/`cancellation_reason`/`failure_reason` → NULL.
 *      The repo sets
 *      `SET LOCAL app.allow_broadcast_redaction = 'on'` internally so
 *      the immutability trigger permits the PII columns to change on
 *      post-`draft` rows (migration 0224).
 *   1a. F119 T082 — `BroadcastApprovalScrubPort`, in the SAME tx: every
 *      approval-round version (`subject`/`body_html`/`body_source`, and
 *      `note_to_member` where one was written) and every decision `reason`
 *      → `'[redacted]'` (rows KEPT — SC-002's proof), and every PENDING
 *      `eblast_*` notification about the member's E-Blasts removed (the
 *      marketing hand-offs go to staff addresses the atomic step's
 *      email-keyed leg cannot find). The inline images were already stamped
 *      here by F2-2 (`markDeletedForMember`, `reason: 'member_erased'`).
 *   2. emit `broadcast_content_redacted` audit (5y retention) with the
 *      content-scrub count + the delivery-tombstone count + reason. The
 *      opaque member id is the only identifier in the payload/summary —
 *      NO email or other plaintext PII.
 *
 * DELIVERY TOMBSTONE moved out (2026-06-18 2nd /code-review, HIGH): the
 * `broadcast_deliveries` tombstone NO LONGER runs here. It runs INSIDE the
 * members-module's atomic scrub tx (while the member's emails are still
 * live), co-committing with `erased_at`, so a first-pass failure of THIS
 * post-commit content scrub can never leave deliveries un-tombstoned and a
 * re-drive (live emails gone) never needs to re-find them. The caller passes
 * the `tombstonedCount` the atomic step already produced so the SINGLE
 * `broadcast_content_redacted` audit still records BOTH counts (no audit
 * split). This use-case is now CONTENT-only.
 *
 * Atomicity: the content scrub UPDATE + the audit emit run inside ONE
 * `broadcastsRepo.withTx(...)` so they co-commit (Constitution
 * Principle I clause 3). The repo method is fail-loud — a DB error
 * propagates, rolls the tx back, and is caught by the outer try/catch
 * which returns `Result.err({ kind: 'scrub.server_error' })`. The
 * members-module adapter maps that to `outcome: 'failed'` so the
 * erasure proof records the cascade as incomplete (no swallow-to-no-op).
 *
 * Idempotency: a re-drive of an already-scrubbed member is a clean no-op.
 * The repo's content UPDATE filters on `subject <> '[redacted]'`, so
 * `scrubbedCount` reflects rows CHANGED, not rows MATCHED (2026-06-19
 * /code-review #4). On a re-drive that count is 0; combined with a 0
 * caller `tombstonedCount`, the zero-work guard below skips the audit, so
 * no DUPLICATE `broadcast_content_redacted` row is emitted. Safe to call
 * multiple times.
 *
 * Never-throws: returns `Result<{ scrubbedCount, tombstonedCount }, …>`
 * (`tombstonedCount` is echoed back from the input for the caller's
 * observability, not produced here).
 */
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { FullMarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { BroadcastApprovalScrubPort } from '../ports/broadcast-approval-scrub-port';
import { auditImagesRemoved } from './_mark-owner-images-removed';

export type ScrubBroadcastContentForMemberError = {
  readonly kind: 'scrub.server_error';
  readonly message: string;
};

/**
 * Bounded reason enum mirrors the F7 cancel cascade's
 * `CascadeCancellationReason` so the audit trail can differentiate
 * GDPR Art. 17 vs PDPA §33 vs a plain archival. Kept as its own alias
 * (no import of F3 types) per Clean Architecture — F7 has no compile
 * dep on F3.
 */
export type ScrubContentReason =
  | 'originator_member_deleted'
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request';

export interface ScrubBroadcastContentForMemberInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  /**
   * The count of `broadcast_deliveries` rows the caller ALREADY tombstoned
   * inside its atomic members-scrub tx (the 2026-06-18 2nd /code-review fix —
   * the delivery tombstone moved OUT of this post-commit step into the atomic
   * step so it co-commits with `erased_at` and survives a first-pass content
   * failure). This use-case does NOT tombstone deliveries itself; it threads
   * this count into the single `broadcast_content_redacted` audit so that one
   * row still records BOTH the content-scrub count and the delivery-tombstone
   * count (no audit split). Defaults to 0 when the caller has no count to
   * report (e.g. a content-only re-drive).
   */
  readonly tombstonedCount?: number;
  /**
   * Reason recorded on the audit row. Default
   * `'originator_member_deleted'`; the erasure caller passes
   * `'gdpr_erasure_request'` (Art. 17) or `'pdpa_deletion_request'`
   * (PDPA §33) for compliance-differentiated forensic trails.
   */
  readonly reason?: ScrubContentReason;
  /**
   * Optional actor user id — the admin who initiated the erasure.
   * Recorded as the audit `actorUserId`. Falls back to `'system'`
   * because the redaction itself is system-initiated (the member is
   * the SUBJECT, not the actor).
   */
  readonly initiatedByUserId: string | null;
  readonly requestId: string | null;
}

export interface ScrubBroadcastContentForMemberOutput {
  readonly scrubbedCount: number;
  readonly tombstonedCount: number;
  /**
   * 108 PR-C T104 — suppression rows whose `member_id` + `contact_id`
   * back-references were nulled here (rows retained, email-keyed).
   */
  readonly suppressionRefsSevered: number;
  /**
   * F119 review finding F2-2 — inline images of the member's E-Blasts whose
   * `deleted_at` was stamped here. The BYTES go on the next daily sweep under
   * the last-reference rule; this count is the erasure proof that the
   * references are gone.
   */
  readonly imagesMarked: number;
  /** F119 T082 — approval-round versions whose content / note was redacted here. */
  readonly versionsRedacted: number;
  /** F119 T082 — member decisions whose reason was redacted here (rows kept). */
  readonly decisionReasonsRedacted: number;
  /** F119 T082 — pending `eblast_*` notifications about the member's E-Blasts removed here. */
  readonly notificationsCancelled: number;
}

export interface ScrubBroadcastContentForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  /**
   * 108 PR-C T104 — `severMemberRefs` runs inside the content-scrub tx so
   * the redaction and the back-reference severing co-commit; it is REQUIRED
   * here at compile time (the port's alias — review 2026-09-07).
   */
  readonly marketingUnsubscribes: FullMarketingUnsubscribesRepo;
  /**
   * F119 review finding F2-2 — REQUIRED. Redacting `subject` / `body_html`
   * removes the POINTER to the member's uploaded photograph; the file itself
   * stayed at its public blob URL, served unchanged, after the erasure was
   * certified complete. A composition that forgets this port must fail at
   * `tsc`, not inside a GDPR erasure transaction.
   */
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedForMember'>;
  /**
   * F119 T082 — REQUIRED for the same reason as `imagesRepo`: the approval
   * round keeps every version, note and reason in two child tables the
   * parent redaction never touches, so an erasure composed without this
   * port would certify complete while the member's words survived there.
   */
  readonly approvalScrub: BroadcastApprovalScrubPort;
}

const SYSTEM_ACTOR_USER_ID = 'system';
const DEFAULT_REASON: ScrubContentReason = 'originator_member_deleted';

export async function scrubBroadcastContentForMember(
  deps: ScrubBroadcastContentForMemberDeps,
  input: ScrubBroadcastContentForMemberInput,
): Promise<
  Result<
    ScrubBroadcastContentForMemberOutput,
    ScrubBroadcastContentForMemberError
  >
> {
  const tenantSlug = input.tenant.slug;
  const reason = input.reason ?? DEFAULT_REASON;
  // The delivery tombstone now runs in the caller's atomic members-scrub tx;
  // its count is threaded in so the single audit records both axes.
  const tombstonedCount = input.tombstonedCount ?? 0;

  try {
    const work = await deps.broadcastsRepo.withTx(async (tx) => {
      // Order: scrub authored content → sever suppression back-references →
      // emit audit. All co-commit in this single tx. (The delivery tombstone
      // is no longer here — it ran in the caller's atomic members-scrub tx;
      // see the file header.)
      const scrub = await deps.broadcastsRepo.scrubContentForMemberInTx(
        tx,
        tenantSlug,
        input.memberId,
      );

      // F119 T082 — the approval round's child tables and pending hand-offs,
      // in this same tx so they co-commit with the parent redaction.
      const versions = await deps.approvalScrub.redactVersionsForMemberInTx(tx, tenantSlug, input.memberId);
      const reasons = await deps.approvalScrub.redactDecisionReasonsForMemberInTx(tx, tenantSlug, input.memberId);
      const notifications = await deps.approvalScrub.cancelPendingNotificationsForMemberInTx(tx, tenantSlug, input.memberId);

      // 108 PR-C T104 (FR-056): null `member_id` + `contact_id` on the
      // member's suppression rows; the email-keyed rows survive. Review
      // 2026-09-07: the port method is optional for unrelated fixtures, so
      // THIS deps type requires it — a composition that forgets to wire it
      // fails at `tsc`, not inside a GDPR erasure transaction.
      const sever = await deps.marketingUnsubscribes.severMemberRefs(tx, tenantSlug, input.memberId);

      // F2-2: the member's UPLOADED IMAGES. Same tx as the redaction, so the
      // pointer and the reference record go together; one `broadcast_image_removed`
      // per row so the sweep's later `reason: 'sweep'` row has an antecedent.
      const stampedImages = await deps.imagesRepo.markDeletedForMember(
        tenantSlug,
        input.memberId as unknown as string,
        new Date(),
        tx,
      );
      await auditImagesRemoved(
        deps.audit,
        {
          tenantId: tenantSlug,
          reason: 'member_erased',
          at: new Date(),
          requestId: input.requestId ?? 'erasure',
          // The erasure is system-initiated; the member is the SUBJECT, not
          // the actor. Never a fabricated role (`check:actor-role-truth`).
          actorUserId: input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
          actorRole: 'system',
          // A deletion is not member activity — `related_member_id`, never the
          // snake_case `member_id` the 0009 trigger reads. Null because the
          // member is being erased: the audit must not re-key to them.
          relatedMemberId: null,
        },
        stampedImages,
        tx,
      );

      // Audit hygiene: skip the `broadcast_content_redacted` emit on a pure
      // no-op (the member authored nothing left to scrub AND the caller
      // tombstoned no deliveries — e.g. a US2d reconciler re-drive after a
      // prior pass already scrubbed everything). This relies on the repo's
      // CHANGED-rows count: `scrubContentForMemberInTx` filters the UPDATE on
      // `subject <> '[redacted]'`, so a re-drive over already-scrubbed rows
      // returns `scrubbedCount = 0` here and the guard fires (2026-06-19
      // /code-review #4 — previously the count was rows MATCHED, so a re-drive
      // returned >= 1 and a DUPLICATE audit was emitted on every re-drive).
      // When there is real work in EITHER axis (newly-changed content OR the
      // caller's delivery tombstone), the audit still fires so both counts
      // are recorded.
      // 108 PR-C T104: severed back-references are a THIRD axis of work.
      // F119 T082: the approval round's three counts are further axes.
      const counts = {
        scrubbedCount: scrub.scrubbedCount,
        suppressionRefsSevered: sever.affected,
        imagesMarked: stampedImages.length,
        versionsRedacted: versions.redactedCount,
        decisionReasonsRedacted: reasons.redactedCount,
        notificationsCancelled: notifications.cancelledCount,
      };
      if (tombstonedCount === 0 && Object.values(counts).every((n) => n === 0)) {
        return counts;
      }

      // S1 type-design: emit via the COMPILE-CHECKED `emitTyped` path
      // (payload constrained by F7AuditPayloadShapes['broadcast_content_redacted'])
      // because this GDPR Art.17 / PDPA §33 redaction-evidence row is
      // compliance-critical — a missing/misshapen forensic field must fail the
      // build, not slip through the wide `Record<string, unknown>` of `emit`.
      await deps.audit.emitTyped(tx, {
        tenantId: tenantSlug,
        eventType: 'broadcast_content_redacted',
        actorUserId: input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
        // No PII: the opaque member uuid is the only identifier; the
        // counts are integers; the reason is a bounded enum. No email
        // or authored content ever appears here.
        summary: `broadcast_content_redacted member=${input.memberId as unknown as string}`,
        payload: {
          member_id: input.memberId as unknown as string,
          scrubbed_count: scrub.scrubbedCount,
          // Threaded from the caller's atomic delivery tombstone (not
          // produced here) so this single audit row records BOTH axes.
          tombstoned_count: tombstonedCount,
          // 108 PR-C T104 — suppression rows whose back-references were
          // nulled (rows retained). A count, never an address.
          suppression_refs_severed: sever.affected,
          // ROUND-2 P-M2 — the image axis, in the same attestation row. The
          // bytes go on the next daily sweep; this count is the evidence that
          // the references are gone.
          images_marked: stampedImages.length,
          // F119 T082 — the approval round's reach, in the same attestation.
          // Counts only; never a subject, a note or a reason.
          versions_redacted: versions.redactedCount,
          decision_reasons_redacted: reasons.redactedCount,
          notifications_cancelled: notifications.cancelledCount,
          reason,
          // Forensic join key: same `cascade` tag the completion/
          // failure logs carry, so the audit row correlates with the
          // structured log. PII-free (a bounded literal).
          cascade: 'f3_member_erasure',
        },
        requestId: input.requestId,
      });

      return counts;
    });

    // Only count an audit emit when one actually happened — a zero-work run
    // skips the emit (above), so it must not bump the audit-emit metric.
    if (tombstonedCount > 0 || Object.values(work).some((n) => n > 0)) {
      broadcastsMetrics.auditEmitCount(tenantSlug, 'broadcast_content_redacted');
    }
    logger.info(
      {
        tenantId: tenantSlug,
        memberId: input.memberId as unknown as string,
        ...work,
        tombstonedCount,
        cascade: 'f3_member_erasure',
      },
      'broadcasts.content_scrub.completed',
    );

    return ok({ ...work, tombstonedCount });
  } catch (e) {
    // Fail-loud: the repo methods + audit emit propagate DB errors so
    // the caller's tx rolls back. We translate the throw to a typed
    // Result so the Application boundary never throws; the members
    // adapter maps this to `outcome: 'failed'` (no swallow-to-no-op).
    // Alertable signal for a stuck content-scrub cascade. Without this, a
    // failed redaction was log-only (greppable, not alertable) — the erased
    // member's AUTHORED content still holds PII until the US2 reconciler
    // re-drives the cascade. (Received deliveries are tombstoned atomically
    // in the caller's scrub tx, so they are NOT at risk from a failure here.)
    // PII-free: tenant only.
    broadcastsMetrics.contentScrubFailed(tenantSlug);
    logger.error(
      {
        // Forbidden-log hygiene (COMP-1 PR-review FIX D): error CLASS name only,
        // never the raw message (a Postgres error can embed SQL param VALUES =
        // the erased member's authored PII). `errKind` supersedes the prior
        // `err`/`errName` pair.
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
        tenantId: tenantSlug,
        memberId: input.memberId as unknown as string,
        cascade: 'f3_member_erasure',
      },
      'broadcasts.content_scrub.failed',
    );
    // NOTE: the returned Result `message` is NOT a log — but it propagates the
    // raw error text to the members-side adapter. That adapter (FIX D) logs only
    // `errKind`, never this `message`, so no raw PG message reaches a log sink.
    return err({
      kind: 'scrub.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
