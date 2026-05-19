/**
 * F6 standalone-audit emit helper — shared between the public webhook
 * route and the admin route handlers.
 *
 * Round-7 R2-F staff-review fix (2026-05-13): extracted from the
 * webhook route's local helper so the admin detail route's
 * `cross_tenant_probe` emit (round-6 B7) can use the same idiom
 * instead of a bare try/catch. The shared helper adds structured
 * `logEvent` / `logMsg` fields on failure that the previous bare
 * catch lacked.
 *
 * Contract:
 *   - Audit failure MUST NEVER block the HTTP response that's already
 *     been decided (404 / 401 / 500 / etc.). Re-throwing on audit
 *     failure would exchange one observability gap (no audit row) for
 *     a worse one (no response + audit row still missing).
 *   - Generic `T` preserves the per-event-type payload narrowing from
 *     `F6AuditPort.emitStandalone<T>` — a `{eventType, payload}`
 *     literal with mismatched payload shape still fails to compile.
 *
 * Composition layer: lives in `src/lib/` (not Application or
 * Infrastructure) because it has no Domain semantic — it is a
 * Presentation-layer try/catch wrapper. Imports from `@/modules/events`
 * are public-barrel types only; no Infrastructure leak.
 */
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import type {
  StandaloneAuditDeps,
  F6AuditEventType,
  F6AuditEntry,
} from '@/modules/events';

/**
 * Known structured-log discriminators for F6 standalone-audit-emit
 * failures. R8-S2 round-8 fix (2026-05-13): tightened from bare
 * `string` to a literal union so a typo at a callsite (e.g.
 * `'..._faileD'`) fails to compile rather than silently breaking
 * the matching alert rule in `docs/observability.md § 24.3`.
 *
 * Add a new variant here whenever you add a new `safeEmitStandalone`
 * callsite. Each variant should be unique to the calling code path
 * so SRE dashboards can isolate audit-failure cause without parsing
 * `tenantSlug`/`event` payloads.
 */
export type SafeEmitFailLogEvent =
  | 'f6_webhook_config_load_audit_failed'
  | 'f6_webhook_sig_reject_audit_failed'
  | 'f6_admin_cross_tenant_probe_audit_failed'
  | 'f6_admin_event_detail_not_found_probe_audit_failed'
  | 'f6_webhook_test_invoked_audit_failed'
  | 'f6_webhook_grace_used_audit_failed';

export async function safeEmitStandalone<T extends F6AuditEventType>(
  deps: StandaloneAuditDeps,
  entry: F6AuditEntry<T>,
  failCtx: {
    tenantSlug: string;
    logEvent: SafeEmitFailLogEvent;
    logMsg: string;
  },
): Promise<void> {
  try {
    const result = await deps.emitStandalone(entry);
    // R8 round-8 fix (2026-05-13, I-5 type-agent finding):
    // `emitStandalone` is typed `Promise<Result<AuditEventId,
    // AuditEmitError>>` — it returns `Result.err` on DB failure
    // rather than throwing. The original try/catch alone would have
    // silently swallowed every audit failure that came back as a
    // resolved-but-err Result. Inspect the Result explicitly here so
    // the structured logger.error fires on Result.err the same way
    // it fires on synchronous throws below.
    if (!result.ok) {
      logger.error(
        {
          event: failCtx.logEvent,
          tenantSlug: failCtx.tenantSlug,
          auditErrorKind: result.error.kind,
          auditErrorMessage:
            'message' in result.error ? result.error.message : null,
        },
        failCtx.logMsg,
      );
    }
    return;
  } catch (auditErr) {
    // R6-W2 staff-review fix (preserved in R7 extraction): scrub
    // container paths + node_modules + webpack-internal:/// from the
    // stack before the pino sink. Pino REDACT_PATHS does not match
    // `errStack` (it is not on the wildcard list); explicit redaction
    // here closes the gap that the original `wrapRepoError` path
    // fixed for repository errors.
    //
    // R8 round-8 fix (2026-05-13): normalise `Error.stack === undefined`
    // (rare — e.g. when `Error.captureStackTrace` is unavailable, or
    // a caller has `delete err.stack`) to `null` so the logged
    // `errStack` field is always either a redacted string OR `null`
    // — never `undefined`, which pino would omit from the structured
    // log and break grep-on-presence in alert rules.
    const rawStack: string | null =
      auditErr instanceof Error && typeof auditErr.stack === 'string'
        ? auditErr.stack
        : null;
    logger.error(
      {
        event: failCtx.logEvent,
        tenantSlug: failCtx.tenantSlug,
        errName: auditErr instanceof Error ? auditErr.name : 'unknown',
        errMessage:
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        errStack: rawStack === null ? null : (redactStack(rawStack) ?? null),
      },
      failCtx.logMsg,
    );
  }
}
