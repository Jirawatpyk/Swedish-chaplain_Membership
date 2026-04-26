/**
 * T105 — Refund aggregate root (F5 / data-model.md § 3).
 *
 * State machine (data-model.md § 3.6):
 *
 *     pending ──┬── succeeded (terminal — processor_refund_id + credit_note_id set)
 *               └── failed    (terminal — failure_reason_code set)
 *
 * Terminal states: succeeded, failed. No retry — admin issues a NEW
 * refund row for another attempt. This mirrors Stripe's own Refund
 * semantics where a failed Refund is final.
 *
 * Invariants (data-model.md § 3.3 + § 3.5):
 *   - amount_satang > 0
 *   - cumulative Σ(succeeded refunds) ≤ payment.amount_satang
 *     (enforced by Application layer `issue-refund.ts` via
 *      `SELECT … FOR UPDATE` on payments(id) before INSERT;
 *      pure-domain VO `RefundableAmount` provides the arithmetic)
 *   - status='succeeded' iff processor_refund_id IS NOT NULL
 *     AND credit_note_id IS NOT NULL
 *   - status='failed' iff failure_reason_code IS NOT NULL
 *   - completed_at IS NULL iff status='pending'
 *
 * Pure TypeScript — no framework/ORM imports.
 */

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const TERMINAL_REFUND_STATUSES = ['succeeded', 'failed'] as const;
export type TerminalRefundStatus = (typeof TERMINAL_REFUND_STATUSES)[number];

export function isTerminalRefundStatus(s: RefundStatus): s is TerminalRefundStatus {
  return (TERMINAL_REFUND_STATUSES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Branded RefundId
// ---------------------------------------------------------------------------

declare const RefundIdBrand: unique symbol;
export type RefundId = string & { readonly [RefundIdBrand]: true };

/**
 * Permissive ULID-like regex. Mirrors `payment.ts` (Crockford base32
 * alphabet — no I, L, O, U) plus `_` separator for prefix schemes
 * (`rfnd_<26-char-ulid>` ≈ 31 chars).
 */
const RE_ULID_LIKE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z_]{20,40}$/;

export type RefundIdError = { readonly kind: 'invalid_refund_id'; readonly raw: string };

/** Unchecked brand cast — use in TRUSTED contexts (DB row → Domain). */
export function asRefundId(raw: string): RefundId {
  return raw as RefundId;
}

/** Validated parse — use at route/webhook boundaries. */
export function parseRefundId(
  raw: string,
): { ok: true; value: RefundId } | { ok: false; error: RefundIdError } {
  if (RE_ULID_LIKE.test(raw)) {
    return { ok: true, value: raw as RefundId };
  }
  return { ok: false, error: { kind: 'invalid_refund_id', raw } };
}

// ---------------------------------------------------------------------------
// Refund aggregate
// ---------------------------------------------------------------------------

import type { PaymentId } from './payment';

export interface Refund {
  readonly id: RefundId;
  readonly tenantId: string;
  readonly paymentId: PaymentId;
  readonly invoiceId: string;

  readonly amountSatang: bigint; // > 0
  readonly reason: string;       // 1..500 chars; sanitised (no CR/LF)
  readonly status: RefundStatus;

  readonly processorRefundId: string | null; // re_…; NOT NULL iff status='succeeded'
  readonly failureReasonCode: string | null; // NOT NULL iff status='failed'
  readonly creditNoteId: string | null;      // F4 CN id; NOT NULL iff status='succeeded'

  readonly initiatedAt: Date;
  readonly completedAt: Date | null;         // NULL iff status='pending'

  readonly initiatorUserId: string;          // FK → users(id); the admin
  readonly correlationId: string;
}

// ---------------------------------------------------------------------------
// State-machine guard — pure
// ---------------------------------------------------------------------------

export type RefundTransitionError =
  | { readonly kind: 'terminal_state'; readonly from: RefundStatus }
  | {
      readonly kind: 'illegal_transition';
      readonly from: RefundStatus;
      readonly to: RefundStatus;
    };

const TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

/**
 * Guard a Refund status transition. Returns ok on a legal move, err
 * otherwise. Does NOT touch persistence — the Application layer pairs
 * this with `SELECT … FOR UPDATE` on `payments(id)`.
 */
export function canTransitionRefund(
  from: RefundStatus,
  to: RefundStatus,
): { ok: true } | { ok: false; error: RefundTransitionError } {
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) {
    return { ok: false, error: { kind: 'terminal_state', from } };
  }
  if (!allowed.includes(to)) {
    return { ok: false, error: { kind: 'illegal_transition', from, to } };
  }
  return { ok: true };
}

export function isLegalRefundTransition(from: RefundStatus, to: RefundStatus): boolean {
  return canTransitionRefund(from, to).ok;
}

// ---------------------------------------------------------------------------
// Completeness invariant — fail-fast on rows that bypass DB CHECKs
// ---------------------------------------------------------------------------

export type RefundCompletenessReason =
  | 'succeeded_missing_processor_refund_id'
  | 'succeeded_missing_credit_note_id'
  | 'failed_missing_failure_reason_code'
  | 'pending_unexpected_completed_at'
  | 'terminal_missing_completed_at';

/**
 * Mirrors data-model.md § 3.3 CHECK constraints. Use at the
 * Application layer when reading rows back from a non-trusted source
 * (e.g. legacy backfills, future direct-SQL migrations).
 */
export function assertRefundComplete(
  r: Refund,
): { ok: true } | { ok: false; reason: RefundCompletenessReason } {
  if (r.status === 'pending') {
    if (r.completedAt !== null) {
      return { ok: false, reason: 'pending_unexpected_completed_at' };
    }
    return { ok: true };
  }
  // terminal
  if (r.completedAt === null) {
    return { ok: false, reason: 'terminal_missing_completed_at' };
  }
  if (r.status === 'succeeded') {
    if (r.processorRefundId === null) {
      return { ok: false, reason: 'succeeded_missing_processor_refund_id' };
    }
    if (r.creditNoteId === null) {
      return { ok: false, reason: 'succeeded_missing_credit_note_id' };
    }
    return { ok: true };
  }
  // status === 'failed'
  if (r.failureReasonCode === null) {
    return { ok: false, reason: 'failed_missing_failure_reason_code' };
  }
  return { ok: true };
}
