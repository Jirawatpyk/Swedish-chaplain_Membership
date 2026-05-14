/**
 * Phase 6 wave-6 round-12 — shared error-shape wrappers.
 *
 * Eliminates the inline-duplicated `return err({ kind, message, cause })`
 * cascades that appeared 11 times across the three Phase 6 use-cases
 * (`apply-quota-effect.ts`, `archive-event.ts`, `toggle-event-category.ts`)
 * after R2-TYPE-B added the `cause` discriminator field.
 *
 * Two helpers:
 *
 *   - `wrapAuditEmitFailure(e: AuditEmitError)` — converts the typed
 *     `AuditEmitError` returned by `F6AuditPort.emit(...)` into the
 *     canonical `audit_emit_failed` shape with both the human-readable
 *     `message` (via `auditEmitErrorMessage`) AND the original
 *     discriminator preserved on `.cause` so route 500 logger.error
 *     can surface the inner `db_error | enum_value_unknown` distinction
 *     for SRE retry-vs-no-retry decisions.
 *
 *   - `wrapLockFailure(e: unknown)` — discriminates between two
 *     fundamentally different catch outcomes:
 *
 *     (R3-CRIT-2) `InvalidLockKeyError` is a PROGRAMMER ERROR / schema
 *     drift bug (e.g., a future `TenantId` brand changes to allow `:`
 *     in values, splitting the canonical key shape). Previously these
 *     fell into the generic `lock_acquisition_failed` bucket — an SRE
 *     runbook filtering on that kind for retry-eligibility would retry
 *     the bug forever. The helper now returns a distinct
 *     `lock_key_invariant_violation` discriminator so retry logic
 *     filters it OUT and pages the on-call instead.
 *
 *     (R3-CRIT-3) Generic Error from the pg driver / Postgres returns
 *     `lock_acquisition_failed` with the original `Error` instance
 *     preserved on `.cause`. Non-Error throws (string / plain object)
 *     are normalised at the catch site into a synthetic `Error` so
 *     pino's `err`-key serializer renders structured `{type, message,
 *     stack}` instead of `{}`.
 *
 * The unified return is a discriminated union — each use-case's
 * `<UseCase>Error` includes both `lock_acquisition_failed` AND
 * `lock_key_invariant_violation` variants so the helper's union
 * structurally fits the err() return.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import type { AuditEmitError } from '../../ports/audit-port';
import { InvalidLockKeyError } from '../../ports/advisory-lock-acquirer';
import { auditEmitErrorMessage } from './audit-error-message';

export type AuditEmitFailure = {
  readonly kind: 'audit_emit_failed';
  readonly message: string;
  readonly cause: AuditEmitError;
};

export function wrapAuditEmitFailure(e: AuditEmitError): AuditEmitFailure {
  return {
    kind: 'audit_emit_failed',
    message: auditEmitErrorMessage(e),
    cause: e,
  };
}

export type LockFailure =
  | {
      readonly kind: 'lock_acquisition_failed';
      readonly message: string;
      readonly cause: Error;
    }
  | {
      readonly kind: 'lock_key_invariant_violation';
      readonly message: string;
      readonly cause: InvalidLockKeyError;
    };

/**
 * Normalise an unknown throw from `advisoryLockAcquirer.acquire()`
 * or `asLockKey()` into a discriminated failure.
 *
 * - `InvalidLockKeyError` → `lock_key_invariant_violation` (programmer
 *   error / schema drift — non-retriable).
 * - Any other `Error` → `lock_acquisition_failed` (transient pg-driver
 *   error — retry-eligible).
 * - Non-Error throws (string / number / plain object) → synthesised
 *   `Error` with a descriptive message so pino's `err` serializer
 *   produces structured logs instead of `{}`.
 */
export function wrapLockFailure(e: unknown): LockFailure {
  if (e instanceof InvalidLockKeyError) {
    return { kind: 'lock_key_invariant_violation', message: e.message, cause: e };
  }
  const normalised =
    e instanceof Error
      ? e
      : new Error(
          `non-error throw: ${
            typeof e === 'object' && e !== null
              ? JSON.stringify(e).slice(0, 200)
              : String(e).slice(0, 200)
          }`,
        );
  return {
    kind: 'lock_acquisition_failed',
    message: normalised.message,
    cause: normalised,
  };
}
