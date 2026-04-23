/**
 * T047 — Payment aggregate root (F5).
 *
 * State machine (data-model.md § 2.5):
 *
 *     pending ──┬── succeeded ──┬── partially_refunded (loop on more partials)
 *               │               └── refunded (terminal)
 *               ├── failed     (terminal)
 *               └── canceled   (terminal)
 *
 * Terminal states: failed, canceled, refunded. `succeeded` is technically
 * non-terminal (can advance to partially_refunded / refunded) but once
 * `refunded` is reached nothing moves further.
 *
 * Invariants (enforced by the Application layer + paired unit tests):
 *   - status transitions pure-checked by `policies/payment-status-transitions.ts`
 *   - at most one `succeeded`-lineage payment per invoice, checked by
 *     `invariants/one-succeeded-payment-per-invoice.ts`
 *   - `card_*` metadata non-null iff `method='card'` (mirrors DB CHECK
 *     `payments_card_metadata_iff_card` migration 0033)
 *   - `failure_reason_code` non-null iff `status='failed'`
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import type { PaymentMethod } from './value-objects/payment-method';

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Terminal state — no transitions out. Used by Application layer to
 * reject follow-up actions (e.g. member-initiated cancel on a refunded
 * payment).
 */
export const TERMINAL_PAYMENT_STATUSES = ['failed', 'canceled', 'refunded'] as const;
export type TerminalPaymentStatus = (typeof TERMINAL_PAYMENT_STATUSES)[number];

export function isTerminalPaymentStatus(
  s: PaymentStatus,
): s is TerminalPaymentStatus {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Branded PaymentId
// ---------------------------------------------------------------------------

declare const PaymentIdBrand: unique symbol;
export type PaymentId = string & { readonly [PaymentIdBrand]: true };

// Permissive ULID-like regex: accepts 20–40 Crockford base32 chars
// (no I/L/O/U) PLUS underscore as the id-prefix separator — Chamber-OS
// payment rows use `pmt_<26-char-ulid>` (~30 chars total). Strict
// Crockford would reject the `_` separator; we allow it here because
// the branded cast is unchecked and route-boundary validation only
// needs to block "wildly wrong" input (empty strings, injection
// attempts). Application repositories use the DB's UNIQUE constraint
// on `payments.id` for authoritative uniqueness.
const RE_ULID_LIKE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z_]{20,40}$/;

export type PaymentIdError = { readonly kind: 'invalid_payment_id'; readonly raw: string };

/** Unchecked brand cast — use in TRUSTED contexts (DB row → Domain). */
export function asPaymentId(raw: string): PaymentId {
  return raw as PaymentId;
}

/** Validated parse — use at route/webhook boundaries. */
export function parsePaymentId(
  raw: string,
): { ok: true; value: PaymentId } | { ok: false; error: PaymentIdError } {
  if (RE_ULID_LIKE.test(raw)) {
    return { ok: true, value: raw as PaymentId };
  }
  return { ok: false, error: { kind: 'invalid_payment_id', raw } };
}

// ---------------------------------------------------------------------------
// Card metadata sub-VO
// ---------------------------------------------------------------------------

/**
 * Last4 + brand + expiry surfaced by Stripe after settlement. SAQ-A:
 * never holds PAN, CVV, or fingerprint. Nullable at the aggregate
 * level because:
 *   - method='promptpay' rows carry no card metadata (NULL everywhere);
 *   - method='card' + status='pending' rows MAY be NULL pre-webhook
 *     (the DB CHECK constraint is relaxed to allow this — see
 *     migration 0033 line 95 commentary), promoted to non-null on
 *     `payment_intent.succeeded`.
 */
export interface CardMetadata {
  readonly brand: string;      // e.g. 'visa', 'mastercard', 'amex'
  readonly last4: string;      // 4 digits, already-masked
  readonly expMonth: number;   // 1–12
  readonly expYear: number;    // 4-digit
}

// ---------------------------------------------------------------------------
// Payment aggregate
// ---------------------------------------------------------------------------

export interface Payment {
  readonly id: PaymentId;
  readonly tenantId: string;
  readonly invoiceId: string;            // UUID at DB; opaque here
  readonly memberId: string;             // UUID at DB

  readonly method: PaymentMethod;
  readonly status: PaymentStatus;

  readonly amountSatang: bigint;         // > 0
  readonly currency: 'THB';

  readonly processorPaymentIntentId: string;   // pi_…
  readonly processorChargeId: string | null;   // ch_…; set on succeeded
  readonly processorEnvironment: 'test' | 'live';
  readonly attemptSeq: number;                 // ≥ 1

  readonly card: CardMetadata | null;

  readonly failureReasonCode: string | null;   // set iff status='failed'

  readonly initiatedAt: Date;
  readonly completedAt: Date | null;           // NULL iff status='pending'

  readonly actorUserId: string;                // member who initiated
  readonly correlationId: string;
}

// ---------------------------------------------------------------------------
// Completeness invariant (reliability-guardian F-03)
// ---------------------------------------------------------------------------

/**
 * Invariant: a `method='card'` payment in a non-pending state MUST carry
 * full card metadata. The DB CHECK `payments_card_metadata_iff_card`
 * (migration 0033 line 95) enforces this at write time; this helper
 * lets the Application layer fail-fast on reads that bypass the CHECK
 * (e.g. future direct-SQL migrations, stale cached rows).
 *
 * promptpay payments always have `card === null` — passing such a row
 * here is a caller bug.
 */
export type CardMetadataIncompleteReason =
  | 'card_metadata_missing_on_non_pending'
  | 'card_metadata_set_on_promptpay';

export function assertCardMetadataComplete(
  p: Payment,
): { ok: true } | { ok: false; reason: CardMetadataIncompleteReason } {
  if (p.method === 'promptpay') {
    if (p.card !== null) {
      return { ok: false, reason: 'card_metadata_set_on_promptpay' };
    }
    return { ok: true };
  }
  // method === 'card'
  if (p.status !== 'pending' && p.card === null) {
    return { ok: false, reason: 'card_metadata_missing_on_non_pending' };
  }
  return { ok: true };
}
