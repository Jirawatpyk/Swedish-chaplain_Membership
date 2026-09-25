/**
 * F119 T054 — `BroadcastVersion`, one formatted version of an E-Blast that
 * marketing prepares and sends to the member (data-model §§ 1, 10).
 *
 * A version is editable only until it is sent to the member; from then on it
 * is the record of what the member was asked to approve, and the
 * `broadcast_versions_immutable_after_send_fn` trigger refuses any change to
 * its content (FR-004, FR-012). `isVersionEditable` is the Domain half of
 * that rule, so the Application answers 409 before the trigger has to.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { BroadcastActorRole, BroadcastId, BroadcastVersionId } from '../broadcast';

export interface BroadcastVersion {
  readonly id: BroadcastVersionId;
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  /** 0 for the working copy opened before the first send; ≥ 0 per the CHECK. */
  readonly versionNo: number;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  /** Marketing's note to the member, ≤ 1,000 chars (FR-006). */
  readonly noteToMember: string | null;
  readonly authoredByUserId: string;
  readonly authoredByRole: BroadcastActorRole;
  /** Stamped when the version is sent to the member; null ⇒ still a working copy. */
  readonly sentToMemberAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isVersionEditable(version: BroadcastVersion): boolean {
  return version.sentToMemberAt === null;
}
