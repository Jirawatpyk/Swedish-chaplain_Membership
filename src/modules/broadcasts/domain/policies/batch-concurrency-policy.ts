/**
 * T042 (F7.1a US1) — Batch concurrency cap policy.
 *
 * FR-002 + Clarifications round-1 Q1: tenant `dispatch_concurrency_cap`
 * is configurable in the 1-8 range with default 4. Defends the cap at
 * the Application layer (typed `Result<void, ConcurrencyError>`)
 * before the value reaches the DB CHECK constraint on
 * `tenant_broadcast_settings.dispatch_concurrency_cap` (migration
 * 0165).
 *
 * The lower bound (1) prevents pathological "0 cap = nothing
 * dispatches" misconfiguration. The upper bound (8) protects shared
 * Resend account-level rate-limit pool (research.md § 4) — anything
 * higher risks self-DOS via account-wide rate-limit incidents.
 *
 * Tenants can opt up to higher concurrency by negotiating an elevated
 * Resend account tier; the cap stays at 8 until a documented review.
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const MIN_CONCURRENCY_CAP = 1 as const;
export const MAX_CONCURRENCY_CAP = 8 as const;
export const DEFAULT_CONCURRENCY_CAP = 4 as const;

export type ConcurrencyError = {
  readonly code: 'batch_concurrency.out_of_range';
  readonly cap: number;
  readonly min: typeof MIN_CONCURRENCY_CAP;
  readonly max: typeof MAX_CONCURRENCY_CAP;
};

/**
 * Validate a concurrency cap. Use at the boundary of
 * `tenant_broadcast_settings` writes (admin update use case, Phase
 * 4+) and at `batch-dispatcher.ts` service init (defence-in-depth).
 */
export function validateConcurrencyCap(
  cap: number,
): Result<void, ConcurrencyError> {
  if (!Number.isInteger(cap) || cap < MIN_CONCURRENCY_CAP || cap > MAX_CONCURRENCY_CAP) {
    return err({
      code: 'batch_concurrency.out_of_range',
      cap,
      min: MIN_CONCURRENCY_CAP,
      max: MAX_CONCURRENCY_CAP,
    });
  }
  return ok(undefined);
}
