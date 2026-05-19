/**
 * R4-I1 (2026-05-18 /speckit-review Round 4) — Result-returning sibling
 * of `emitOrThrow` for use-cases that propagate audit-emit failures via
 * `Result.err` instead of throwing.
 *
 * Background: R3-C1 closed the silent-failure class at the `emitOrThrow`
 * boundary (used by `processAttendeeInTx` strict-tx pipeline). However
 * ~23 direct `audit.emit()` callers across 12 F6 files use the
 * Result-handling pattern:
 *
 *   const r = await deps.audit.emit({...});
 *   if (!r.ok) return err(wrapAuditEmitFailure(r.error));
 *
 * This pattern handles `Result.err` correctly but is BYPASSED by a
 * raw throw from `audit.emit()` (pool exhaust panic, sub-adapter
 * regression). The raw throw escapes the use-case as an uncaught
 * exception, which propagates up to the caller's framework error
 * boundary — silently misclassified in SRE alerts as `unknown` instead
 * of `audit_emit`.
 *
 * **Fix**: route all direct `audit.emit()` through `safeAuditEmit` which
 * converts raw throws into `Result.err({ kind: 'db_error', message })`
 * matching the existing Result-handler shape. Callers see ONE Result
 * branch to discriminate; the raw-throw vector is closed at the
 * helper boundary without changing any caller's return shape.
 *
 * Usage:
 * ```ts
 * const r = await safeAuditEmit(deps.audit, { eventType: '...', ... });
 * if (!r.ok) return err(wrapAuditEmitFailure(r.error));
 * ```
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { err, type Result } from '@/lib/result';
import type { AuditEventId } from '@/modules/auth';
import type {
  F6AuditPort,
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../../ports/audit-port';
// /code-review (2026-05-19 post-ship) — import from the leaf module
// `./safe-stringify` instead of `./process-attendee-in-tx` to break a
// 3-file circular import cycle. See `./safe-stringify.ts` header for
// the cycle diagram + TDZ-fragility rationale.
import { safeStringify } from './safe-stringify';

/**
 * Wraps `audit.emit()` to catch raw throws and convert them into the
 * same `Result.err({kind:'db_error', ...})` shape that callers already
 * handle. Result.err from the underlying emitter passes through
 * unchanged.
 */
export async function safeAuditEmit<T extends F6AuditEventType>(
  audit: F6AuditPort,
  entry: F6AuditEntry<T>,
): Promise<Result<AuditEventId, AuditEmitError>> {
  try {
    return await audit.emit(entry);
  } catch (raw) {
    // Raw throw from `audit.emit()` (DB-layer panic, sub-adapter
    // regression). Convert into the canonical `db_error` Result.err
    // shape so the caller's existing `if (!r.ok)` Result-handler
    // catches it. `safeStringify` preserves diagnostic content from
    // non-Error throws (e.g. `{kind:'POOL_EXHAUSTED',...}`).
    const messageFromRaw =
      raw instanceof Error ? raw.message : safeStringify(raw);
    return err({
      kind: 'db_error',
      message: `audit emit threw: ${messageFromRaw}`,
    });
  }
}
