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
}

export interface ScrubBroadcastContentForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
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
    const { scrubbedCount } = await deps.broadcastsRepo.withTx(async (tx) => {
      // Order: scrub authored content → emit audit. Both co-commit in this
      // single tx. (The delivery tombstone is no longer here — it ran in the
      // caller's atomic members-scrub tx; see the file header.)
      const scrub = await deps.broadcastsRepo.scrubContentForMemberInTx(
        tx,
        tenantSlug,
        input.memberId,
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
      if (scrub.scrubbedCount === 0 && tombstonedCount === 0) {
        return { scrubbedCount: 0 };
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
          reason,
          // Forensic join key: same `cascade` tag the completion/
          // failure logs carry, so the audit row correlates with the
          // structured log. PII-free (a bounded literal).
          cascade: 'f3_member_erasure',
        },
        requestId: input.requestId,
      });

      return { scrubbedCount: scrub.scrubbedCount };
    });

    // Only count an audit emit when one actually happened — a zero-work run
    // skips the emit (above), so it must not bump the audit-emit metric.
    if (scrubbedCount > 0 || tombstonedCount > 0) {
      broadcastsMetrics.auditEmitCount(tenantSlug, 'broadcast_content_redacted');
    }
    logger.info(
      {
        tenantId: tenantSlug,
        memberId: input.memberId as unknown as string,
        scrubbedCount,
        tombstonedCount,
        cascade: 'f3_member_erasure',
      },
      'broadcasts.content_scrub.completed',
    );

    return ok({ scrubbedCount, tombstonedCount });
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
