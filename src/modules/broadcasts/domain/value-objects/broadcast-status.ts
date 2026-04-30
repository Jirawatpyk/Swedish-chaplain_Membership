/**
 * T024 — `BroadcastStatus` Domain value object (F7).
 *
 * 8-state lifecycle constant tuple (FR-004 + FR-004a). Mirrors the
 * `broadcastStatusEnum` in Infrastructure schema verbatim. The
 * Domain owns the **transition policy** (`broadcast-status-transitions.ts`);
 * Infrastructure owns the **DB enum + state-machine trigger** (data-model § 4.2).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const BROADCAST_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'sending',
  'sent',
  'rejected',
  'cancelled',
  'failed_to_dispatch',
] as const;

export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/**
 * Terminal states have no outbound transitions. Reaching one of these
 * means the broadcast lifecycle is over (or, in the `rejected`/
 * `cancelled`/`failed_to_dispatch` cases, was over before reaching
 * `sent`). Quota reservation is released on terminal states other
 * than `sent`; for `sent` the slot is *consumed* (FR-007).
 */
export function isTerminalStatus(status: BroadcastStatus): boolean {
  return (
    status === 'sent' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'failed_to_dispatch'
  );
}

/**
 * Type guard for runtime narrowing of an unknown string.
 */
export function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  return (
    typeof value === 'string' &&
    (BROADCAST_STATUSES as readonly string[]).includes(value)
  );
}
