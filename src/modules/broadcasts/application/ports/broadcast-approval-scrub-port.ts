/**
 * F119 T082 — `BroadcastApprovalScrubPort` Application port (research R17,
 * spec § Personal data, data-model §§ 1–2 "Erasure").
 *
 * The approval round's reach into GDPR Art. 17 / PDPA §33 erasure. Called by
 * `scrubBroadcastContentForMember` inside the SAME transaction as
 * `scrubContentForMemberInTx` (the members cascade's content step), so the
 * parent redaction, the child redaction, the image stamp and the attestation
 * audit co-commit or roll back together:
 *
 *   - every `broadcast_versions` row of every E-Blast the member originated:
 *     `subject`, `body_html`, `body_source` → `'[redacted]'`, and
 *     `note_to_member` → `'[redacted]'` where a note was written (a note that
 *     never existed stays NULL — a sentinel there would invent one);
 *   - every `broadcast_member_decisions.reason` → `'[redacted]'` (an approval
 *     without a note keeps its NULL);
 *   - every PENDING `eblast_*` outbox row about those E-Blasts is removed, so
 *     no hand-off email is rendered after the erasure. The atomic erasure step
 *     already removes rows addressed to the member's own contacts; the
 *     marketing hand-offs go to STAFF addresses, which only this leg finds.
 *
 * ROWS ARE KEPT: version numbers, rounds, decisions, actors and timestamps
 * are SC-002's proof of who approved what, and they carry no content.
 *
 * Every method is idempotent and returns the count of rows it CHANGED (not
 * matched), so a re-drive over an already-erased member reports zero and the
 * caller's zero-work guard skips a duplicate attestation.
 *
 * Every method runs on the caller's `runInTenant` `tx` — REQUIRED, never the
 * pool-global `db` (RLS bypass, the F7.1a US2 rule).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { MemberId } from '@/modules/members';
import type { TenantSlug } from '@/modules/tenants';

/** Opaque tx handle from `BroadcastsRepo.withTx`. */
export type BroadcastApprovalScrubTx = unknown;

export interface BroadcastApprovalScrubPort {
  /** Redact the content and the note of every version of the member's E-Blasts. */
  redactVersionsForMemberInTx(
    tx: BroadcastApprovalScrubTx,
    tenantId: TenantSlug,
    memberId: MemberId,
  ): Promise<{ readonly redactedCount: number }>;

  /** Redact the reason of every decision on the member's E-Blasts. */
  redactDecisionReasonsForMemberInTx(
    tx: BroadcastApprovalScrubTx,
    tenantId: TenantSlug,
    memberId: MemberId,
  ): Promise<{ readonly redactedCount: number }>;

  /** Remove every pending `eblast_*` notification about the member's E-Blasts. */
  cancelPendingNotificationsForMemberInTx(
    tx: BroadcastApprovalScrubTx,
    tenantId: TenantSlug,
    memberId: MemberId,
  ): Promise<{ readonly cancelledCount: number }>;
}
