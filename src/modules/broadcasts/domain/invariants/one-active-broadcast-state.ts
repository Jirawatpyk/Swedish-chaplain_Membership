/**
 * T025 — `one-active-broadcast-state` invariant (F7).
 *
 * Domain-layer sanity check that a `Broadcast` aggregate's lifecycle
 * timestamps agree with its `status` field. Each status has a
 * mandatory + forbidden timestamp set; this invariant ensures the
 * aggregate is internally consistent before persistence.
 *
 * Defence-in-depth pairs with the DB-level `broadcasts_immutable_after_submit_fn`
 * + state-machine triggers (data-model § 4.1 + § 4.2). The DB enforces
 * the transition; this invariant catches any in-memory aggregate
 * mutation that desyncs status ↔ timestamp before the row reaches
 * the DB.
 *
 * Rules per status:
 *   - draft: submittedAt/approvedAt/rejectedAt/sendingStartedAt/sentAt/cancelledAt/failedToDispatchAt all NULL
 *   - submitted: submittedAt non-null; approvedAt/rejectedAt/sendingStartedAt/sentAt/cancelledAt/failedToDispatchAt NULL
 *   - approved: submittedAt + approvedAt non-null; rest NULL (excl. scheduledFor which can be set)
 *   - sending: submittedAt + approvedAt + sendingStartedAt non-null; sentAt/failedToDispatchAt/rejectedAt/cancelledAt NULL
 *   - sent: submittedAt + approvedAt + sendingStartedAt + sentAt non-null; quotaYearConsumed + quotaConsumedAt non-null (FR-007)
 *   - rejected: submittedAt + rejectedAt + rejectedByUserId + rejectionReason non-null
 *   - cancelled: submittedAt + cancelledAt + cancelledByUserId non-null
 *   - failed_to_dispatch: submittedAt + approvedAt + sendingStartedAt + failedToDispatchAt + failureReason non-null; sentAt NULL
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { Broadcast } from '../broadcast';

export type OneActiveBroadcastStateError = {
  readonly kind: 'broadcast.state_timestamp_mismatch';
  readonly status: Broadcast['status'];
  readonly violations: ReadonlyArray<string>;
};

interface FieldRule {
  readonly field: keyof Broadcast;
  readonly mustBeNull: boolean;
}

/**
 * Per-status expected nullability of lifecycle fields. `true` in
 * `mustBeNull` means the field MUST be null in this status; `false`
 * means it MUST be non-null. Fields not listed for a status are
 * unconstrained (e.g., `scheduledFor` may be set in any non-draft
 * state per US6).
 */
const RULES: Readonly<Record<Broadcast['status'], ReadonlyArray<FieldRule>>> = {
  draft: [
    { field: 'submittedAt', mustBeNull: true },
    { field: 'approvedAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'sendingStartedAt', mustBeNull: true },
    { field: 'sentAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  submitted: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'sendingStartedAt', mustBeNull: true },
    { field: 'sentAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  approved: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'approvedByUserId', mustBeNull: false },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'sendingStartedAt', mustBeNull: true },
    { field: 'sentAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  sending: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: false },
    { field: 'sentAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  sent: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: false },
    { field: 'sentAt', mustBeNull: false },
    { field: 'quotaYearConsumed', mustBeNull: false },
    { field: 'quotaConsumedAt', mustBeNull: false },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
  ],
  rejected: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'rejectedAt', mustBeNull: false },
    { field: 'rejectedByUserId', mustBeNull: false },
    { field: 'rejectionReason', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: true },
    { field: 'sentAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  cancelled: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'cancelledAt', mustBeNull: false },
    { field: 'cancelledByUserId', mustBeNull: false },
    { field: 'sentAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  failed_to_dispatch: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: false },
    { field: 'failedToDispatchAt', mustBeNull: false },
    { field: 'failureReason', mustBeNull: false },
    { field: 'sentAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  // F7.1a US1 (Phase 3 B0 — added 2026-05-19, FR-008a/b).
  // `partially_sent`: in-flight; sendingStartedAt set, manualRetryCount
  // 0-3, NOT yet quotaConsumed (consumed only on terminal `sent` per
  // FR-007). May still progress to `sending` (admin retry) or
  // `partial_delivery_accepted` (admin accept).
  partially_sent: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: false },
    { field: 'sentAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'partialDeliveryAcceptedAt', mustBeNull: true },
    { field: 'partialDeliveryAcceptedByUserId', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: true },
    { field: 'quotaConsumedAt', mustBeNull: true },
  ],
  // `partial_delivery_accepted` (TERMINAL): admin explicit accept of
  // partial delivery; sets partial_delivery_accepted_at + _by_user_id.
  // Quota IS consumed (the delivered batches count as a real send;
  // FR-008c semantics).
  partial_delivery_accepted: [
    { field: 'submittedAt', mustBeNull: false },
    { field: 'approvedAt', mustBeNull: false },
    { field: 'sendingStartedAt', mustBeNull: false },
    { field: 'partialDeliveryAcceptedAt', mustBeNull: false },
    { field: 'partialDeliveryAcceptedByUserId', mustBeNull: false },
    { field: 'sentAt', mustBeNull: true },
    { field: 'rejectedAt', mustBeNull: true },
    { field: 'cancelledAt', mustBeNull: true },
    { field: 'failedToDispatchAt', mustBeNull: true },
    { field: 'quotaYearConsumed', mustBeNull: false },
    { field: 'quotaConsumedAt', mustBeNull: false },
  ],
};

export function enforceOneActiveBroadcastState(
  broadcast: Broadcast,
): Result<true, OneActiveBroadcastStateError> {
  const rules = RULES[broadcast.status];
  const violations: string[] = [];
  for (const { field, mustBeNull } of rules) {
    const value = broadcast[field];
    const isNull = value === null || value === undefined;
    if (mustBeNull && !isNull) {
      violations.push(`${String(field)} expected NULL in status='${broadcast.status}' but was set`);
    } else if (!mustBeNull && isNull) {
      violations.push(`${String(field)} expected non-NULL in status='${broadcast.status}' but was NULL`);
    }
  }
  if (violations.length > 0) {
    return err({
      kind: 'broadcast.state_timestamp_mismatch',
      status: broadcast.status,
      violations,
    });
  }
  return ok(true);
}
