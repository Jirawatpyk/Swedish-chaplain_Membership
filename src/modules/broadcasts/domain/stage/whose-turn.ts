/**
 * F119 T052 — whose turn it is at each stage (FR-026, data-model § 8.1).
 *
 * **Marketing** for Awaiting marketing review, In design, Changes requested
 * and Member approved; **Member** for Awaiting member approval; **null**
 * ("—", nobody is waiting) for Draft, Scheduled, Sending and every closed or
 * historical stage.
 *
 * There is deliberately no `'system'` turn: a stage the dispatcher owns is
 * one nobody is waiting on, and the dashboard must not invite a staff user to
 * act on it.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { BroadcastStatus } from '../value-objects/broadcast-status';

export type WhoseTurn = 'marketing' | 'member' | null;

const TURN_OF: Readonly<Record<BroadcastStatus, WhoseTurn>> = {
  draft: null,
  submitted: 'marketing',
  in_design: 'marketing',
  awaiting_member_approval: 'member',
  changes_requested: 'marketing',
  member_approved: 'marketing',
  approved: null,
  sending: null,
  sent: null,
  rejected: null,
  cancelled: null,
  expired_no_member_response: null,
  failed_to_dispatch: null,
  partially_sent: null,
  partial_delivery_accepted: null,
};

export function turnOf(status: BroadcastStatus): WhoseTurn {
  return TURN_OF[status];
}
