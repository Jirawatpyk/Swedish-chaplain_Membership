/**
 * T034 (F8 Phase 2 Wave D) — `RenewalCycle` aggregate root.
 *
 * Domain shape of the F8 `renewal_cycles` row (data-model.md § 2.1).
 * Mirrors the migration 0087 columns 1:1 with TypeScript-typed
 * lifecycle anchors + state-machine helpers.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 *
 * Invariants encoded here (mirror DB CHECK constraints + data-model L137-138):
 *   - period_to > period_from
 *   - cycle_length_months ∈ (0, 60]
 *   - frozen_plan_price_thb ≥ 0
 *   - frozen_plan_term_months ∈ (0, 60]
 *   - completed → linked_invoice_id NOT NULL
 *   - closed_at NOT NULL ↔ status terminal (completed | lapsed | cancelled)
 *   - pending_admin_reactivation ↔ entered_pending_at NOT NULL
 *
 * The `assertCycleInvariants` function returns Result<void, CycleInvariantError>
 * collecting every violation; callers can choose to short-circuit on first
 * or fail-loud with the full list.
 */
import { err, ok, type Result } from '@/lib/result';
import {
  type CycleStatus,
  isTerminalCycleStatus,
} from './value-objects/cycle-status';
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

/** Mirrors data-model.md § 2.1 closed_reason enum verbatim. */
export const CLOSED_REASONS = [
  'paid',
  'cancelled',
  'lapsed',
  'completed_offline',
  'admin_reactivated',
  'admin_rejected_with_refund',
  'pending_reactivation_timed_out',
] as const;

export type ClosedReason = (typeof CLOSED_REASONS)[number];

export interface RenewalCycle {
  readonly tenantId: string;
  readonly cycleId: CycleId;
  readonly memberId: string;

  readonly status: CycleStatus;

  /** ISO 8601 UTC; period_to > period_from invariant. */
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Denormalised copy of period_to maintained by DB trigger. */
  readonly expiresAt: string;
  readonly cycleLengthMonths: number;

  /** Frozen tier bucket at cycle creation (FR-021a). */
  readonly tierAtCycleStart: TierBucket;
  readonly planIdAtCycleStart: string;
  /** Decimal string from Postgres `decimal(12,2)`. Application layer parses if needed. */
  readonly frozenPlanPriceThb: string;
  readonly frozenPlanTermMonths: number;
  readonly frozenPlanCurrency: 'THB';

  /** Set when status transitions to pending_admin_reactivation (FR-005c reminder ladder anchor). */
  readonly enteredPendingAt: string | null;

  readonly linkedInvoiceId: string | null;
  readonly linkedCreditNoteId: string | null;
  readonly closedAt: string | null;
  readonly closedReason: ClosedReason | null;

  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CycleInvariantError =
  | { readonly kind: 'period_order_violation' }
  | { readonly kind: 'cycle_length_out_of_range'; readonly months: number }
  | { readonly kind: 'frozen_price_negative'; readonly priceThb: string }
  | { readonly kind: 'frozen_term_out_of_range'; readonly months: number }
  | { readonly kind: 'completed_requires_invoice' }
  | { readonly kind: 'closed_at_terminal_mismatch'; readonly status: CycleStatus; readonly closedAt: string | null }
  | { readonly kind: 'pending_at_status_mismatch'; readonly status: CycleStatus; readonly enteredPendingAt: string | null };

/**
 * Run all invariant checks. Returns `ok` only when every invariant
 * holds; otherwise returns the FIRST violation (consistent with the
 * project's other Result-returning validators — callers asking for
 * full violation lists pre-validate the row before construction).
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
  if (cycle.status === 'completed' && cycle.linkedInvoiceId == null) {
    return err({ kind: 'completed_requires_invoice' });
  }
  // closed_at NOT NULL ↔ status terminal.
  const isTerminal = isTerminalCycleStatus(cycle.status);
  if (isTerminal && cycle.closedAt == null) {
    return err({
      kind: 'closed_at_terminal_mismatch',
      status: cycle.status,
      closedAt: cycle.closedAt,
    });
  }
  if (!isTerminal && cycle.closedAt != null) {
    return err({
      kind: 'closed_at_terminal_mismatch',
      status: cycle.status,
      closedAt: cycle.closedAt,
    });
  }
  // pending_admin_reactivation ↔ entered_pending_at NOT NULL.
  if (
    cycle.status === 'pending_admin_reactivation' &&
    cycle.enteredPendingAt == null
  ) {
    return err({
      kind: 'pending_at_status_mismatch',
      status: cycle.status,
      enteredPendingAt: cycle.enteredPendingAt,
    });
  }
  if (
    cycle.status !== 'pending_admin_reactivation' &&
    cycle.enteredPendingAt != null
  ) {
    return err({
      kind: 'pending_at_status_mismatch',
      status: cycle.status,
      enteredPendingAt: cycle.enteredPendingAt,
    });
  }
  return ok(undefined);
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
