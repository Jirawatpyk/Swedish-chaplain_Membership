/**
 * R5.4 / Round 4 I-8 — shared error-message formatter that preserves
 * ES2022 `Error.cause` info on the rendered string.
 *
 * Round 3 R3.3.2 + R3.3.3 introduced near-identical cause-appending
 * logic at two sites:
 *   - `import-csv.ts` `toErrMessage` (15 call sites — audit payload
 *      `errorMessage` + log `err` field)
 *   - `ingest-webhook-attendee.ts:384` outer-catch (rolled-back audit
 *      `errorMessage`)
 *
 * Both wrap a TxStageError-class error and need to surface the
 * underlying cause discriminator (PostgresError + connection-terminated
 * vs MarkRefundedError + already_refunded vs AuditEmitError.db_error
 * etc) so SRE forensics can distinguish failure modes on the audit
 * fallback log line.
 *
 * Contract:
 *   - Non-Error input → `String(e)` (preserves backward compat).
 *   - Error without cause → `e.message`.
 *   - Error with Error-typed cause → `${e.message} (cause: ${cause.name}: ${cause.message})`.
 *   - Error with non-Error cause (string, primitive) → `e.message` only
 *     (backward compat — non-Error causes are dropped by design).
 *
 * Pure function — no framework imports, no logging. Lives in
 * application/use-cases/_helpers so callers in `application/use-cases/`
 * import it without breaking Principle III (Domain ← Application ←
 * Infrastructure direction).
 */
export function formatErrorWithCause(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.cause instanceof Error) {
    return `${e.message} (cause: ${e.cause.name}: ${e.cause.message})`;
  }
  return e.message;
}
