/**
 * T025 — `quota-counter-non-negative` invariant (F7).
 *
 * Domain-layer invariant guarding FR-008: a member's quota counter
 * must never go negative under ANY transition. The
 * `asQuotaCounter` factory enforces this at construction time; this
 * invariant function is the dedicated reusable check called by
 * `compute-quota-counter.ts` use case AND by mutation paths
 * (submit / sent / rejected / cancelled / failed_to_dispatch) before
 * persistence to catch drift introduced by future code changes.
 *
 * Defence-in-depth: the DB also enforces non-negative semantics via
 * the `broadcasts_quota_year_only_on_sent` CHECK + the derived view
 * arithmetic (a row only counts toward quota in `sending` or `sent`
 * status — derived counts are never negative by construction).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { QuotaCounter } from '../value-objects/quota-counter';

export type QuotaCounterInvariantError =
  | {
      readonly kind: 'quota.remaining_negative';
      readonly remaining: number;
    }
  | {
      readonly kind: 'quota.over_subscription';
      readonly used: number;
      readonly reserved: number;
      readonly cap: number;
    }
  | {
      readonly kind: 'quota.negative_field';
      readonly field: 'used' | 'reserved' | 'cap';
      readonly value: number;
    };

/**
 * Pure check returning `Result<true, QuotaCounterInvariantError>`. The
 * factory `asQuotaCounter` already enforces these — this is the
 * idempotent re-check meant for downstream Application use-cases that
 * mutate the counter (increment/decrement) and need to assert the
 * result is still valid before commit.
 */
export function enforceQuotaCounterNonNegative(
  counter: QuotaCounter,
): Result<true, QuotaCounterInvariantError> {
  if (counter.cap < 0) {
    return err({ kind: 'quota.negative_field', field: 'cap', value: counter.cap });
  }
  if (counter.used < 0) {
    return err({ kind: 'quota.negative_field', field: 'used', value: counter.used });
  }
  if (counter.reserved < 0) {
    return err({
      kind: 'quota.negative_field',
      field: 'reserved',
      value: counter.reserved,
    });
  }
  if (counter.used + counter.reserved > counter.cap) {
    return err({
      kind: 'quota.over_subscription',
      used: counter.used,
      reserved: counter.reserved,
      cap: counter.cap,
    });
  }
  if (counter.remaining < 0) {
    return err({ kind: 'quota.remaining_negative', remaining: counter.remaining });
  }
  return ok(true);
}
