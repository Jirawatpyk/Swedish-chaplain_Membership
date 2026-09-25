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
import { BROADCAST_STATUSES, type BroadcastStatus } from '../value-objects/broadcast-status';

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

/**
 * F119 T132 — the E-Blasts waiting on MARKETING: every status whose turn is
 * `'marketing'`, derived from the map above so it cannot drift from it. The
 * ONE set behind both the `broadcasts_marketing_turn_count` gauge and the
 * staff nav's live waiting count (FR-023, contracts § 1.3 / § 4.1). Raw SQL
 * that needs it in an `IN (...)` derives it from here.
 */
export const MARKETING_TURN_STATUSES: readonly BroadcastStatus[] = BROADCAST_STATUSES.filter(
  (status) => TURN_OF[status] === 'marketing',
);

/**
 * UX review H1 — whether a dashboard view holds only stages somebody is
 * waiting on. Such a view reads longest-in-stage first (the oldest wait is the
 * most urgent); any other view — one with a Sent, Scheduled or closed stage in
 * it, or the show-all view (no stage selected) — reads most recent first, or
 * its first page would be the oldest history instead of the latest.
 *
 * `[].every(...)` is vacuously true, so the empty (show-all) view is refused
 * explicitly.
 */
export function isWaitingView(statuses: readonly BroadcastStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => TURN_OF[status] !== null);
}
