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
 *   - processor_refund_id is set once Stripe *accepts* the refund
 *     request, which may happen while status is still 'pending' (the
 *     Stripe Refund object itself can be asynchronously pending); it is
 *     NOT a reliable status='succeeded' discriminator on its own.
 *   - status='succeeded' iff credit_note_id IS NOT NULL (credit_note_id
 *     is only ever attached after the refund settles)
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
//
// Chamber-OS refund rows use the format `rfnd_<26-char-ulid>` (~31 chars).
// Regex + parser scaffold lives in `value-objects/branded-ulid-id.ts`
// (shared with `PaymentId`).

import { makeUlidIdHelpers } from './value-objects/branded-ulid-id';

declare const RefundIdBrand: unique symbol;
export type RefundId = string & { readonly [RefundIdBrand]: true };

export type RefundIdError = { readonly kind: 'invalid_refund_id'; readonly raw: string };

const _refundIdHelpers = makeUlidIdHelpers<RefundId, 'invalid_refund_id'>(
  'invalid_refund_id',
);

/** Unchecked brand cast — use in TRUSTED contexts (DB row → Domain). */
export const asRefundId = _refundIdHelpers.as;

/** Validated parse — use at route/webhook boundaries. */
export const parseRefundId = _refundIdHelpers.parse;

// ---------------------------------------------------------------------------
// Refund aggregate
// ---------------------------------------------------------------------------

import type { PaymentId } from './payment';
import type { Satang } from '@/lib/money';

export interface Refund {
  readonly id: RefundId;
  readonly tenantId: string;
  readonly paymentId: PaymentId;
  readonly invoiceId: string;

  // F5R3 H-5 (2026-05-16) — branded Satang prevents unit confusion
  // (baht vs satang) at compile time across F4+F5+F8.
  readonly amountSatang: Satang; // > 0
  readonly reason: string;       // 1..500 chars; sanitised (no CR/LF)
  readonly status: RefundStatus;

  readonly processorRefundId: string | null; // re_…; set once Stripe accepts (may be non-null while status='pending')
  readonly failureReasonCode: string | null; // NOT NULL iff status='failed'
  readonly creditNoteId: string | null;      // F4 CN id; NOT NULL iff status='succeeded'

  readonly initiatedAt: Date;
  readonly completedAt: Date | null;         // NULL iff status='pending'

  readonly initiatorUserId: string;          // FK → users(id); the admin
  readonly correlationId: string;
}

// ---------------------------------------------------------------------------
// State-machine guard — pure (delegates to shared `_state-machine.ts`)
// ---------------------------------------------------------------------------

import {
  makeStateMachine,
  type StateMachineError,
} from './policies/_state-machine';

export type RefundTransitionError = StateMachineError<RefundStatus>;

const TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

const _refundStateMachine = makeStateMachine<RefundStatus>(TRANSITIONS);

/**
 * Guard a Refund status transition. Returns ok on a legal move, err
 * otherwise. Does NOT touch persistence — the Application layer pairs
 * this with `SELECT … FOR UPDATE` on `payments(id)`.
 */
export const canTransitionRefund = _refundStateMachine.canTransition;
export const isLegalRefundTransition = _refundStateMachine.isLegalTransition;

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
