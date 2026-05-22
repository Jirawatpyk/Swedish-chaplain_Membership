/**
 * T024 — `BroadcastStatus` Domain value object (F7) + F7.1a Phase 3 B0
 * extension (2026-05-19).
 *
 * 10-state lifecycle constant tuple (FR-004 + FR-004a + FR-008a/b).
 * Mirrors the `broadcastStatusEnum` in Infrastructure schema + DB
 * pgEnum (migrations 0064 + 0169) verbatim. The Domain owns the
 * **transition policy** (`broadcast-status-transitions.ts`);
 * Infrastructure owns the **DB enum + state-machine trigger**
 * (data-model § 4.2).
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
  // F7.1a US1 — Phase 3 B0 extension
  'partially_sent',
  'partial_delivery_accepted',
] as const;

export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/**
 * Terminal states have no outbound transitions. Reaching one of these
 * means the broadcast lifecycle is over (or, in the `rejected`/
 * `cancelled`/`failed_to_dispatch` cases, was over before reaching
 * `sent`). Quota reservation is released on terminal states other
 * than `sent`; for `sent` the slot is *consumed* (FR-007).
 *
 * F7.1a Phase 3 B0: `partial_delivery_accepted` is terminal (admin
 * explicit accept). `partially_sent` is NON-terminal — admin can
 * retry up to 3 times (FR-008a `manual_retry_count` CHECK 0..3) or
 * accept partial delivery to reach the terminal state.
 */
export function isTerminalStatus(status: BroadcastStatus): boolean {
  return (
    status === 'sent' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'failed_to_dispatch' ||
    status === 'partial_delivery_accepted'
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
