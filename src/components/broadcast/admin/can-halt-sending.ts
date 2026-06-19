import type { BroadcastStatus } from '@/modules/broadcasts';
import type { BatchBreakdownRow } from './batch-breakdown';

/**
 * F7.1a US1 FR-004 — should the admin mid-dispatch "Halt sending" control show?
 *
 * True only when the broadcast is in-flight (`sending`) AND at least one batch
 * is still PENDING (not yet dispatched). A batch already in `sending` is at
 * Resend and cannot be recalled, so it does NOT count toward haltability. A
 * batch-load failure forces `false` (fail-safe — never offer a halt we can't
 * back with batch data; the page shows a separate load-error panel instead).
 *
 * This mirrors the use-case's haltable set exactly (`findPendingByBroadcast`
 * selects DB status `'pending'`), so the render-time gate and the click-time
 * re-read agree on the same filter — a stale snapshot only ever loses a race
 * gracefully (→ `broadcast_cancel_too_late`), never over-halts.
 *
 * Extracted as a pure function so the show/hide decision (including the
 * fail-safe-to-hidden and "no pending batches" branches) is unit-testable
 * without rendering the RSC page.
 */
export function canHaltSending(
  status: BroadcastStatus,
  batchLoadFailed: boolean,
  batches: ReadonlyArray<Pick<BatchBreakdownRow, 'status'>>,
): boolean {
  return (
    status === 'sending' &&
    !batchLoadFailed &&
    batches.some((b) => b.status === 'pending')
  );
}
