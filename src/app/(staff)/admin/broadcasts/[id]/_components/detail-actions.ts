import { canCancel, canTransition, type BroadcastStatus } from '@/modules/broadcasts';
import type { StartConfirm } from '@/components/broadcast/approval/start-formatted-version-action';

/**
 * Which controls the staff E-Blast detail offers — the SERVER decides which
 * controls exist, and the page and the preview harness both read this one
 * function (spec 122 US12c-1 follow-up, 20 Oct: the harness's own copy had
 * drifted and drew member approved and held without Start or Change schedule).
 */
export interface DetailActionInputs {
  readonly status: BroadcastStatus;
  readonly round: number;
  /** `broadcasts.write` — a manager holds `broadcasts.read` only. */
  readonly canWrite: boolean;
  /** `broadcasts.send` — the schedule route's key. */
  readonly canSend: boolean;
  readonly memberApprovalOn: boolean;
  readonly bodyRenderFailed: boolean;
}

export interface DetailActions {
  readonly showStart: boolean;
  readonly startConfirm: StartConfirm;
  readonly showSchedule: boolean;
  readonly isCancellable: boolean;
  readonly showApprove: boolean;
  readonly showReject: boolean;
  readonly showActionRow: boolean;
}

export function detailActions(input: DetailActionInputs): DetailActions {
  const { status, round, canWrite, canSend, memberApprovalOn, bodyRenderFailed } = input;
  // T152 — the flag gates the `submitted → in_design` edge in the use case;
  // hiding the button is a UI affordance only, never the gate. From
  // `changes_requested`, and from `member_approved`/`approved` once a round
  // has run, the route answers 201 in both flag states (FR-034 — an in-flight
  // E-Blast stays completable), so the control follows the route, not the flag.
  const voidsApproval = (status === 'member_approved' || status === 'approved') && round >= 1;
  const showStart =
    canWrite && ((status === 'submitted' && memberApprovalOn) || status === 'changes_requested' || voidsApproval);
  const showSchedule = canSend && (status === 'member_approved' || (status === 'approved' && round >= 1));
  // M3 — what starting a version costs from this stage, so the island asks
  // (or not) before it posts: from `submitted` it ends approve-as-submitted.
  const startConfirm: StartConfirm =
    status === 'submitted' ? 'leaves_submitted' : voidsApproval ? 'voids_approval' : 'none';
  // F119 T051 — Cancel reads the Domain cut-off (`canCancel`), the same policy
  // the `/cancel` use case enforces. B1 — Approve is approve-AS-SUBMITTED, so
  // it stays `submitted`-only (and refuses content the server could not
  // render, IMP-3); Reject follows the Domain edge T081 widened
  // (`canTransition(status, 'rejected')` — every pre-send stage but
  // `approved`), which is what the `/reject` use case enforces.
  const isCancellable = canCancel(status);
  const showApprove = canWrite && status === 'submitted' && !bodyRenderFailed;
  const showReject = canWrite && canTransition(status, 'rejected');
  const showActionRow = canWrite && (isCancellable || showApprove || showReject || showStart || showSchedule);
  return { showStart, startConfirm, showSchedule, isCancellable, showApprove, showReject, showActionRow };
}
