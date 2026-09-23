/**
 * F119 T052 — the FR-019 stage of an E-Blast, derived from its status
 * (data-model § 8.1).
 *
 * Exactly one stage per status, and no two live statuses share one. The two
 * retired statuses (`partially_sent`, `partial_delivery_accepted`) map to
 * `historical`, a stage that no filter offers — a historical row must still
 * render, but nobody should be handed a chip that can only return zero rows.
 *
 * `approved` is the stage FR-019 calls **Scheduled**: it is the only
 * dispatchable status, reached by marketing confirming the send time.
 *
 * A `Record` keyed on `BroadcastStatus` rather than a `switch`: a missing
 * status is a compile error, and there is no default arm to fail open.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { BroadcastStatus } from '../value-objects/broadcast-status';

export const BROADCAST_STAGES = [
  'draft',
  'awaiting_marketing_review',
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
  'scheduled',
  'sending',
  'sent',
  'rejected',
  'cancelled',
  'expired',
  'failed',
  'historical',
] as const;

export type BroadcastStage = (typeof BROADCAST_STAGES)[number];

const STAGE_OF: Readonly<Record<BroadcastStatus, BroadcastStage>> = {
  draft: 'draft',
  submitted: 'awaiting_marketing_review',
  in_design: 'in_design',
  awaiting_member_approval: 'awaiting_member_approval',
  changes_requested: 'changes_requested',
  member_approved: 'member_approved',
  approved: 'scheduled',
  sending: 'sending',
  sent: 'sent',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired_no_member_response: 'expired',
  failed_to_dispatch: 'failed',
  partially_sent: 'historical',
  partial_delivery_accepted: 'historical',
};

export function stageOf(status: BroadcastStatus): BroadcastStage {
  return STAGE_OF[status];
}
