/**
 * F119 T087 · T141a · T083 — what the MEMBER side may see of an E-Blast's
 * approval round (contracts/portal-eblast-approval-api.md § `GET …/[id]/versions`
 * and § `GET /api/broadcasts/[id]`; FR-008, FR-032, FR-049; research R17).
 *
 * One projection for the three member-facing reads — the portal thread, the
 * portal detail and the DSAR archive — so they cannot drift into three
 * different ideas of what a member is shown:
 *
 *   - a version is visible only once SENT to the member (`sentToMemberAt`
 *     set). The unsent working copy is marketing's work in progress and never
 *     leaves this module on a member path (FR-003's read side). v0 — the
 *     member's original — is stamped at materialisation, so it is visible;
 *   - the author is `'member'` or `'organisation'`, never a staff user id or
 *     name (the F114 `decidedBy: 'organisation'` precedent). It follows the
 *     role the author actually held: the member's own self-service original
 *     is `'member'`; a staff proxy draft and every formatted version are
 *     `'organisation'`;
 *   - v0's `sentToMemberAt` is reported as null: the member wrote it, nobody
 *     sent it to them (the contract's example). The stored stamp exists only
 *     to make the row read-only;
 *   - `confirmedSendAt` is `scheduled_for` only once marketing has confirmed
 *     it (the `approved` stage and after). Before that the column still holds
 *     the member's submit-time request, which is the PROPOSAL, not a
 *     confirmation.
 *
 * Pure Application — Domain imports only.
 */
import type { Broadcast, BroadcastActorRole } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import type { MemberDecision, MemberDecisionKind } from '../../../domain/approval/member-decision';
import { memberApprovalExpiresAt } from '../../../domain/approval/member-approval-expiry';
import { stageOf, type BroadcastStage } from '../../../domain/stage/broadcast-stage';
import { turnOf, type WhoseTurn } from '../../../domain/stage/whose-turn';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';

export type MemberVisibleAuthor = 'member' | 'organisation';

export interface MemberWorkflowSummary {
  readonly stage: BroadcastStage;
  readonly whoseTurn: WhoseTurn;
  readonly round: number;
  readonly proposedSendAt: Date | null;
  readonly confirmedSendAt: Date | null;
  readonly approvedVersionId: string | null;
  readonly stageEnteredAt: Date;
  /** `stageEnteredAt` + 30 days while the E-Blast awaits the member (FR-022a); null otherwise. */
  readonly expiresAt: Date | null;
}

export interface MemberVisibleVersion {
  readonly id: string;
  readonly broadcastId: string;
  readonly versionNo: number;
  readonly authoredBy: MemberVisibleAuthor;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly noteToMember: string | null;
  readonly sentToMemberAt: Date | null;
  readonly createdAt: Date;
}

export interface MemberVisibleDecision {
  readonly id: string;
  readonly broadcastId: string;
  readonly versionId: string;
  readonly round: number;
  readonly decision: MemberDecisionKind;
  readonly reason: string | null;
  readonly decidedAt: Date;
}

/** The statuses at which `scheduled_for` is a time marketing CONFIRMED. */
const CONFIRMED_SCHEDULE_STATUSES: ReadonlySet<BroadcastStatus> = new Set<BroadcastStatus>([
  'approved',
  'sending',
  'sent',
  'failed_to_dispatch',
  'partially_sent',
  'partial_delivery_accepted',
]);

export function memberWorkflowSummary(broadcast: Broadcast): MemberWorkflowSummary {
  const awaiting = broadcast.status === 'awaiting_member_approval';
  return {
    stage: stageOf(broadcast.status),
    whoseTurn: turnOf(broadcast.status),
    round: broadcast.currentRound,
    proposedSendAt: broadcast.proposedSendAt,
    confirmedSendAt: CONFIRMED_SCHEDULE_STATUSES.has(broadcast.status) ? broadcast.scheduledFor : null,
    approvedVersionId: broadcast.approvedVersionId,
    stageEnteredAt: broadcast.stageEnteredAt,
    expiresAt: awaiting ? memberApprovalExpiresAt(broadcast.stageEnteredAt) : null,
  };
}

export function isVisibleToMember(version: BroadcastVersion): boolean {
  return version.sentToMemberAt !== null;
}

export function authoredByForMember(role: BroadcastActorRole): MemberVisibleAuthor {
  return role === 'member_self_service' ? 'member' : 'organisation';
}

/** The member-visible projection of a version the caller has already filtered with `isVisibleToMember`. */
export function projectVersionForMember(version: BroadcastVersion): MemberVisibleVersion {
  return {
    id: version.id,
    broadcastId: version.broadcastId as string,
    versionNo: version.versionNo,
    authoredBy: authoredByForMember(version.authoredByRole),
    subject: version.subject,
    bodyHtml: version.bodyHtml,
    noteToMember: version.noteToMember,
    sentToMemberAt: version.versionNo === 0 ? null : version.sentToMemberAt,
    createdAt: version.createdAt,
  };
}

export function projectDecisionForMember(decision: MemberDecision): MemberVisibleDecision {
  return {
    id: decision.id,
    broadcastId: decision.broadcastId as string,
    versionId: decision.versionId,
    round: decision.round,
    decision: decision.decision,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
  };
}

/** The highest-numbered version SENT to the member (v1+) — what awaits their decision. */
export function latestSentVersion(versions: readonly BroadcastVersion[]): BroadcastVersion | null {
  return versions.reduce<BroadcastVersion | null>(
    (latest, v) => (v.versionNo >= 1 && v.sentToMemberAt !== null && (latest === null || v.versionNo > latest.versionNo) ? v : latest),
    null,
  );
}
