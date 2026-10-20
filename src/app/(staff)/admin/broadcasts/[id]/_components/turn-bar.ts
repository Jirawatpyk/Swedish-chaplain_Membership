import { memberApprovalExpiresAt, type BroadcastStatus } from '@/modules/broadcasts';

/**
 * The "whose turn" bar under the staff detail header (spec 122 US12c-1
 * follow-up, maintainer 20 Oct; boards `Admin-broadcast-review`,
 * `Admin-eblast-design`, `-awaiting-member`, `-changes-requested`,
 * `-member-approved`): who acts next and what. Null once nobody does.
 */
export type TurnBar =
  | { readonly kind: 'review'; readonly canFormat: boolean }
  | { readonly kind: 'design' }
  | { readonly kind: 'awaitingMember'; readonly version: number; readonly sentAt: Date; readonly expiresAt: Date }
  /** Past the 30 days, before the daily job closes the row: say so, never a past expiry date. */
  | { readonly kind: 'awaitingMemberExpired'; readonly version: number; readonly sentAt: Date }
  | { readonly kind: 'changesRequested'; readonly nextVersion: number }
  | { readonly kind: 'confirmSchedule'; readonly proposedAt: Date | null };

export interface TurnBarInputs {
  readonly status: BroadcastStatus;
  readonly round: number;
  readonly memberApprovalOn: boolean;
  /** Sending a version to the member enters `awaiting_member_approval`, so this is when it was sent. */
  readonly stageEnteredAt: Date;
  readonly proposedSendAt: Date | null;
  readonly now: Date;
}

export function turnBar(input: TurnBarInputs): TurnBar | null {
  const { status, round, memberApprovalOn, stageEnteredAt, proposedSendAt, now } = input;
  switch (status) {
    case 'submitted':
      return { kind: 'review', canFormat: memberApprovalOn };
    case 'in_design':
      return { kind: 'design' };
    case 'awaiting_member_approval': {
      const expiresAt = memberApprovalExpiresAt(stageEnteredAt);
      if (expiresAt.getTime() <= now.getTime()) {
        return { kind: 'awaitingMemberExpired', version: round, sentAt: stageEnteredAt };
      }
      return {
        kind: 'awaitingMember',
        version: round,
        sentAt: stageEnteredAt,
        expiresAt,
      };
    }
    case 'changes_requested':
      return { kind: 'changesRequested', nextVersion: round + 1 };
    case 'member_approved':
      return { kind: 'confirmSchedule', proposedAt: proposedSendAt };
    default:
      return null;
  }
}
