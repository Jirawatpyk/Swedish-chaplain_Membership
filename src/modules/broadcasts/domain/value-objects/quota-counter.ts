/**
 * T024 — `QuotaCounter` Domain value object (F7).
 *
 * Immutable view of a member's E-Blast quota for the current quota year
 * (FR-003 + FR-006 + FR-007 + FR-008). Computed by Application layer
 * `compute-quota-counter.ts` use case from a derived view of the
 * `broadcasts` table — never persisted directly.
 *
 * Invariants (enforced by `asQuotaCounter` factory + the
 * `quota-counter-non-negative` invariant at every Domain boundary):
 *   - `cap >= 0`
 *   - `used >= 0`
 *   - `reserved >= 0`
 *   - `used + reserved <= cap`
 *   - `remaining = cap - used - reserved` (computed; not stored)
 *
 * `reserved` slots are broadcasts in `submitted` or `approved` state — they
 * have not been consumed (sent → quota_year_consumed) but MUST count against
 * the cap so a member cannot exceed their plan while a broadcast awaits review.
 * Reservation is released on transition to `rejected`, `cancelled`, or
 * `failed_to_dispatch` (Design D1, 2026-06-21 — failed_to_dispatch is terminal
 * with no re-trigger route, so holding the slot would be a permanent lockout).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export interface QuotaCounter {
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly cap: number;
}

export type QuotaCounterError =
  | { readonly code: 'quota_counter.negative_cap'; readonly cap: number }
  | { readonly code: 'quota_counter.negative_used'; readonly used: number }
  | {
      readonly code: 'quota_counter.negative_reserved';
      readonly reserved: number;
    }
  | {
      readonly code: 'quota_counter.over_subscription';
      readonly used: number;
      readonly reserved: number;
      readonly cap: number;
    }
  | {
      readonly code: 'quota_counter.non_integer';
      readonly field: 'used' | 'reserved' | 'cap';
      readonly value: number;
    };

/**
 * Construct a `QuotaCounter` enforcing all invariants. Returns a typed
 * Result so callers can surface clean error codes.
 */
export function asQuotaCounter(input: {
  readonly used: number;
  readonly reserved: number;
  readonly cap: number;
}): Result<QuotaCounter, QuotaCounterError> {
  const { used, reserved, cap } = input;
  if (!Number.isInteger(used)) {
    return err({ code: 'quota_counter.non_integer', field: 'used', value: used });
  }
  if (!Number.isInteger(reserved)) {
    return err({
      code: 'quota_counter.non_integer',
      field: 'reserved',
      value: reserved,
    });
  }
  if (!Number.isInteger(cap)) {
    return err({ code: 'quota_counter.non_integer', field: 'cap', value: cap });
  }
  if (cap < 0) return err({ code: 'quota_counter.negative_cap', cap });
  if (used < 0) return err({ code: 'quota_counter.negative_used', used });
  if (reserved < 0) {
    return err({ code: 'quota_counter.negative_reserved', reserved });
  }
  if (used + reserved > cap) {
    return err({
      code: 'quota_counter.over_subscription',
      used,
      reserved,
      cap,
    });
  }
  return ok({
    used,
    reserved,
    remaining: cap - used - reserved,
    cap,
  });
}

/**
 * Convenience zero-state factory. Useful for tier=0 / non-paying
 * members (FR-002 precondition `a` will reject before quota computation,
 * but the counter is still rendered on the benefits page).
 */
export function zeroQuota(cap: number): QuotaCounter {
  return { used: 0, reserved: 0, remaining: Math.max(cap, 0), cap: Math.max(cap, 0) };
}

/**
 * Pure boolean predicate — does this counter have a slot available
 * for a NEW submission (consumes a `reserved` slot at submit-time)?
 * Mirror of FR-003 reservation check.
 */
export function hasRemainingSlot(counter: QuotaCounter): boolean {
  return counter.remaining > 0;
}
