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

export async function safeEmitStandalone<T extends F6AuditEventType>(
  deps: StandaloneAuditDeps,
  entry: F6AuditEntry<T>,
  failCtx: { tenantSlug: string; logEvent: string; logMsg: string },
): Promise<void> {
  try {
    await deps.emitStandalone(entry);
  } catch (auditErr) {
    // R6-W2 staff-review fix (preserved in R7 extraction): scrub
    // container paths + node_modules + webpack-internal:/// from the
    // stack before the pino sink. Pino REDACT_PATHS does not match
    // `errStack` (it is not on the wildcard list); explicit redaction
    // here closes the gap that the original `wrapRepoError` path
    // fixed for repository errors.
    const rawStack = auditErr instanceof Error ? auditErr.stack : null;
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
