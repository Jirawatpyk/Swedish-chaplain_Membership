/**
 * `RenewalCycle` aggregate root — Domain entity for the F8
 * `renewal_cycles` row (data-model.md § 2.1).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 *
 * Invariants:
 *   The status-conditional invariants (closed_at ↔ terminal,
 *   pending_admin_reactivation ↔ entered_pending_at, completed →
 *   linked_invoice_id) are encoded as a **discriminated union** over
 *   `status` so the type system rejects illegal combinations at
 *   compile time. Every consumer that narrows on `cycle.status`
 *   automatically gets the right nullability for the lifecycle
 *   anchors.
 *
 *   Numeric/range invariants (period_to > period_from,
 *   cycle_length_months ∈ (0, 60], frozen_plan_price_thb ≥ 0,
 *   frozen_plan_term_months ∈ (0, 60]) remain runtime-checked via
 *   `assertCycleInvariants` — TypeScript can't express bounded
 *   numbers without dependent types.
 */
import { err, ok, type Result } from '@/lib/result';
import { parseThbDecimalToSatang } from '@/lib/money';
import { isTerminalCycleStatus } from './value-objects/cycle-status';
import { type TierBucket } from './value-objects/tier-bucket';

declare const CycleIdBrand: unique symbol;
export type CycleId = string & { readonly [CycleIdBrand]: true };

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CycleIdError = {
  readonly kind: 'invalid_cycle_id';
  readonly raw: string;
};

export function asCycleId(raw: string): CycleId {
  return raw as CycleId;
}

export function parseCycleId(raw: string): Result<CycleId, CycleIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_cycle_id', raw });
  }
  return ok(raw as CycleId);
}

/**
 * Mirrors data-model.md § 2.1 closed_reason enum verbatim.
 *
 * `'lapsed'` is the legacy catch-all for "any non-paid expiry path"
 * — kept for backward compat with rows written before the lapse-
 * decision branch ships in a future cycle-state-reconciler use-case. Two more specific
 * reasons land in the same enum forward-compatibly:
 *
 *   - `'grace_expired'` — `now > expires_at + grace_period_days`
 *     and the member never attempted payment (or all attempts
 *     remained `pending`/`processing`)
 *   - `'payment_failed'` — at least one F5 payment attempt failed
 *     permanently before the grace window ended
 *
 * The two literals are present in the enum so the DB CHECK +
 * Domain narrowing accept them today; the dispatcher writes only
 * `'lapsed'` until the cycle-state-reconciler use-case wires the
 * decision branch (deferred — see T115a tasks.md entry).
 */
export const CLOSED_REASONS = [
  'paid',
  'cancelled',
  'lapsed',
  'grace_expired',
  'payment_failed',
  'completed_offline',
  'admin_reactivated',
  'admin_rejected_with_refund',
  'pending_reactivation_timed_out',
] as const;

export type ClosedReason = (typeof CLOSED_REASONS)[number];

/**
 * K7: compile-time count assertion — pin the const tuple length so
 * accidentally adding/dropping a closed_reason becomes a build error.
 * Mirrors `_AssertCycleStatusCount` and `_AssertSkipReasonCount`.
 * Keep in sync with the DB CHECK constraint in migration 0108.
 */
type _AssertClosedReasonCount = (typeof CLOSED_REASONS)['length'] extends 9
  ? true
  : 'CLOSED_REASONS count mismatch — expected 9';
const _assertClosedReasonCount: _AssertClosedReasonCount = true;
void _assertClosedReasonCount;

/**
 * Fields shared across every cycle status. Lifecycle-anchor fields
 * (`status`, `closedAt`, `closedReason`, `enteredPendingAt`,
 * `linkedInvoiceId`) live in the per-status union arms below so
 * narrowing on `cycle.status` produces the correct nullability.
 */
interface RenewalCycleBase {
  readonly tenantId: string;
  readonly cycleId: CycleId;
  readonly memberId: string;

  /** ISO 8601 UTC; period_to > period_from invariant. */
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Denormalised copy of period_to maintained by DB trigger. */
  readonly expiresAt: string;
  readonly cycleLengthMonths: number;

  /** Frozen tier bucket at cycle creation (FR-021a). */
  readonly tierAtCycleStart: TierBucket;
  readonly planIdAtCycleStart: string;
  /** Decimal string from Postgres `decimal(12,2)`. Use `cycleFrozenPriceSatang(cycle)` for cross-module bigint. */
  readonly frozenPlanPriceThb: string;
  readonly frozenPlanTermMonths: number;
  readonly frozenPlanCurrency: 'THB';

  readonly linkedCreditNoteId: string | null;

  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Active (non-terminal) cycle in the standard reminder lifecycle. */
interface ActiveCycleFields {
  readonly status: 'upcoming' | 'reminded' | 'awaiting_payment';
  readonly enteredPendingAt: null;
  readonly closedAt: null;
  readonly closedReason: null;
  readonly linkedInvoiceId: string | null;
}

/** Lapsed member who paid but awaits admin verification (FR-005c). */
interface PendingReactivationCycleFields {
  readonly status: 'pending_admin_reactivation';
  /** Set when transitioning into this state — anchor for FR-005c ladder. */
  readonly enteredPendingAt: string;
  readonly closedAt: null;
  readonly closedReason: null;
  readonly linkedInvoiceId: string | null;
}

/** Terminal — paid + invoiced. linkedInvoiceId is required (DB CHECK). */
interface CompletedCycleFields {
  readonly status: 'completed';
  readonly enteredPendingAt: null;
  readonly closedAt: string;
  readonly closedReason: 'paid' | 'completed_offline' | 'admin_reactivated';
  readonly linkedInvoiceId: string;
}

/** Terminal — grace expired or admin-reactivation timed out. */
interface LapsedCycleFields {
  readonly status: 'lapsed';
  readonly enteredPendingAt: null;
  readonly closedAt: string;
  // T115a forward-compat: `'grace_expired'` and `'payment_failed'`
  // accepted today; dispatcher writes only `'lapsed'` until the cycle-state-reconciler ships
  // wires the lapse-decision branch.
  readonly closedReason:
    | 'lapsed'
    | 'grace_expired'
    | 'payment_failed'
    | 'pending_reactivation_timed_out';
  readonly linkedInvoiceId: string | null;
}

/** Terminal — admin-cancelled or admin-rejected with refund. */
interface CancelledCycleFields {
  readonly status: 'cancelled';
  readonly enteredPendingAt: null;
  readonly closedAt: string;
  readonly closedReason: 'cancelled' | 'admin_rejected_with_refund';
  readonly linkedInvoiceId: string | null;
}

/**
 * RenewalCycle — discriminated over `status`. Narrowing examples:
 *   - `if (cycle.status === 'completed') cycle.linkedInvoiceId.length` ✅
 *   - `if (cycle.status === 'cancelled') cycle.closedAt` ✅ (string)
 *   - `if (cycle.status === 'upcoming') cycle.closedAt` ✅ (null)
 */
export type RenewalCycle = RenewalCycleBase &
  (
    | ActiveCycleFields
    | PendingReactivationCycleFields
    | CompletedCycleFields
    | LapsedCycleFields
    | CancelledCycleFields
  );

export type CycleInvariantError =
  | { readonly kind: 'period_order_violation' }
  | { readonly kind: 'cycle_length_out_of_range'; readonly months: number }
  | { readonly kind: 'frozen_price_negative'; readonly priceThb: string }
  | { readonly kind: 'frozen_term_out_of_range'; readonly months: number };

/**
 * Run the runtime invariants that the type system can't express
 * (numeric ranges + period order). Status-conditional invariants
 * (closed_at ↔ terminal, pending_admin_reactivation ↔
 * enteredPendingAt, completed → linkedInvoiceId) are enforced at
 * compile time by the `RenewalCycle` discriminated union.
 *
 * Returns the FIRST violation (consistent with project Result-returning
 * validators — callers asking for full violation lists pre-validate
 * the row before construction).
 */
export function assertCycleInvariants(
  cycle: RenewalCycle,
): Result<void, CycleInvariantError> {
  if (
    Date.parse(cycle.periodTo) <= Date.parse(cycle.periodFrom)
  ) {
    return err({ kind: 'period_order_violation' });
  }
  if (cycle.cycleLengthMonths <= 0 || cycle.cycleLengthMonths > 60) {
    return err({
      kind: 'cycle_length_out_of_range',
      months: cycle.cycleLengthMonths,
    });
  }
  // frozenPlanPriceThb is a decimal string; numeric parse rejects negatives.
  const priceNum = Number(cycle.frozenPlanPriceThb);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return err({
      kind: 'frozen_price_negative',
      priceThb: cycle.frozenPlanPriceThb,
    });
  }
  if (cycle.frozenPlanTermMonths <= 0 || cycle.frozenPlanTermMonths > 60) {
    return err({
      kind: 'frozen_term_out_of_range',
      months: cycle.frozenPlanTermMonths,
    });
  }
  return ok(undefined);
}

/**
 * Convert the cycle's frozen plan price to satang (bigint) — the F4
 * + F5 monetary representation (`Money.satang`). The DB stores the
 * frozen price as `decimal(12,2)` in THB units to match the existing
 * F2 plan-fee storage convention, but cross-module callers (F4 invoice
 * issuance, F5 payment intent amount) need bigint satang to integrate
 * with their existing arithmetic. This helper is the canonical
 * conversion site — single source of truth + lossless rounding via
 * cents-multiplication.
 */
export function cycleFrozenPriceSatang(cycle: RenewalCycle): bigint {
  // Single conversion site for cross-module bigint arithmetic (F4
  // invoice issue, F5 PaymentIntent.amount). Delegates the integer-only
  // parse to the shared `parseThbDecimalToSatang` (@/lib/money) — both
  // this helper and the F4↔F8 frozen-price bridge (FR-022) use that one
  // parser so there is exactly one audited THB-decimal→satang routine.
  // A silent wrong-magnitude bigint here charges the wrong amount in
  // production, so the malformed-input throw is re-wrapped with the
  // cycle id for forensic context.
  try {
    return parseThbDecimalToSatang(cycle.frozenPlanPriceThb);
  } catch {
    throw new Error(
      `cycleFrozenPriceSatang: malformed frozenPlanPriceThb "${cycle.frozenPlanPriceThb}" for cycle ${cycle.cycleId} — expected decimal(12,2) format`,
    );
  }
}

/** True if the cycle is past its expires_at + still non-terminal. */
export function isOverdue(cycle: RenewalCycle, now: Date): boolean {
  if (isTerminalCycleStatus(cycle.status)) return false;
  return Date.parse(cycle.expiresAt) < now.getTime();
}

/**
 * Compute days remaining to expires_at (negative = overdue). Returns
 * a finite integer or NaN if the column is malformed.
 */
export function daysUntilExpiry(cycle: RenewalCycle, now: Date): number {
  const expires = Date.parse(cycle.expiresAt);
  if (!Number.isFinite(expires)) return NaN;
  const ms = expires - now.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
