/**
 * Drizzle adapter for F8 `RenewalAuditEmitter`.
 *
 * Persists F8 events to F1's `audit_log` for event types present in
 * the `audit_event_type` pgEnum (see `F8_ENUM_SHIPPED` below — the
 * canonical runtime list, kept in sync with enum-extension migrations).
 * Events outside that set fall through to pino-logging via
 * `pinoFallback` and loud-fail in production so a misconfigured emit
 * site never silently drops audit data.
 *
 * Behaviour:
 *   - `emit(event, ctx)`: own runInTenant tx; never throws to caller
 *     (fire-and-forget; probe audits depend on this contract).
 *   - `emitInTx(tx, event, ctx)`: writes inside supplied tx so state
 *     + audit commit atomically (Constitution Principle VIII).
 *
 * NULL `retention_years` lets the DB trigger apply the F8 default of
 * 5 years — we don't override.
 */
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import {
  isF8AuditEventType,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditEventType,
  type RenewalAuditEmitter,
} from '../../application/ports/renewal-audit-emitter';
import type { AuditLogInsert } from '@/modules/auth/infrastructure/db/schema';

/**
 * F8 event types whose pgEnum value exists today. Each entry MUST
 * have a corresponding `ALTER TYPE "audit_event_type" ADD VALUE` in a
 * shipped migration. Events not in this set fall through to pino-
 * logging (loud-fail in production).
 *
 * Migration 0099 ships the 4 events emitted by Phase 3 use-cases:
 *   - `renewal_cycle_cancelled`            (cancel-cycle.ts)
 *   - `renewal_cycle_completed_offline`    (mark-paid-offline.ts)
 *   - `renewal_cross_tenant_probe`         (3 use-cases probe path)
 *   - `f8_role_violation_blocked`          (renewals-route-helpers)
 *
 * `renewal_cycle_created` is reserved for the Phase 4 cycle-creation
 * hook (F4 invoice-paid callback) and will be added here alongside
 * its ADD VALUE migration when that emit site lands.
 */
const F8_ENUM_SHIPPED: ReadonlySet<F8AuditEventType> = new Set([
  'renewal_cycle_cancelled',
  'renewal_cycle_completed_offline',
  'renewal_cross_tenant_probe',
  'f8_role_violation_blocked',
]);

function buildSummary<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): string {
  const base = ctx.summary?.trim();
  if (base && base.length > 0) {
    return base.slice(0, 500);
  }
  // Default summary mirrors F4 audit-adapter convention.
  return `F8 ${event.type} (tenant=${ctx.tenantId})`.slice(0, 500);
}

/**
 * Defensive `Object.keys` for audit payloads. `Object.keys(null)` and
 * `Object.keys(undefined)` throw TypeError; the audit-emit catch path
 * MUST NOT throw inside its own diagnostic logging or it masks the
 * original signal. Returns `[]` for null/undefined/non-object payloads.
 */
function payloadKeysOf(payload: unknown): readonly string[] {
  if (payload == null || typeof payload !== 'object') return [];
  return Object.keys(payload as Record<string, unknown>);
}

function pinoFallback<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
  reason: 'not_in_pgenum' | 'unknown_event_type',
): void {
  // Production guard — same property the stub asserts. F8 ships dark
  // behind FEATURE_F8_RENEWALS=false until MVP-wide go-live; if we ever
  // emit a non-enum event in production the audit-trail invariant
  // (Principle VIII) silently breaks.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `F8 audit emit fell through to pino in production (event=${event.type}, reason=${reason}). ` +
        'Add the event to the audit_event_type pgEnum migration before flipping FEATURE_F8_RENEWALS=true.',
    );
  }
  // Emit at WARN so CI / staging log-based alerts trip on emit-site drift
  // (an INFO log would blend into normal traffic). Log payload KEYS only
  // — never values — so a future PII-bearing event never leaks raw.
  logger.warn(
    {
      f8AuditFallthrough: true,
      reason,
      eventType: event.type,
      tenantId: ctx.tenantId,
      actorRole: ctx.actorRole,
      correlationId: ctx.correlationId,
      payloadKeys: payloadKeysOf(event.payload),
    },
    'F8 audit emit fell back to pino — event type not in pgEnum yet',
  );
}

function buildInsertValues<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): AuditLogInsert {
  return {
    // event.type narrows to the F8AuditEventType union; the
    // auditEventTypeEnum union in the Drizzle schema includes these
    // values after migration 0099. Cast through the canonical enum
    // type for safety.
    eventType: event.type as AuditLogInsert['eventType'],
    actorUserId: ctx.actorUserId ?? `system:${ctx.actorRole}`,
    summary: buildSummary(event, ctx),
    requestId: ctx.requestId ?? ctx.correlationId,
    tenantId: ctx.tenantId,
    payload: event.payload,
    // timestamp + id default at DB layer (defaultRandom + defaultNow).
  };
}

export function makeDrizzleRenewalAuditEmitter(
  tenant: TenantContext,
): RenewalAuditEmitter {
  return {
    async emit<E extends F8AuditEventType>(
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // Pre-flight enum checks run OUTSIDE the try/catch so the
      // production-mode loud-fail in `pinoFallback` propagates to the
      // caller — that throw exists specifically to detect emit-site
      // drift before flag-flip and MUST NOT be swallowed.
      // The fire-and-forget contract still applies to runtime DB faults
      // (RLS misconfig, infra outage), which are caught + logged below.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        return;
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        return;
      }
      try {
        await runInTenant(tenant, async (tx) => {
          await tx.insert(auditLog).values(buildInsertValues(event, ctx));
        });
      } catch (e) {
        // Forensic log — fire-and-forget contract swallows the throw,
        // but the log line is the ONLY signal that audit data was lost,
        // so capture full diagnostic context (Sentry triage 6 months
        // later depends on it). Never include raw event.payload here —
        // payload keys only.
        logger.error(
          {
            err: e,
            errCode:
              e instanceof Error && 'code' in e
                ? (e as { code?: string }).code
                : undefined,
            eventType: event.type,
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            payloadKeys: payloadKeysOf(event.payload),
          },
          'F8 audit emit DB insert failed (fire-and-forget swallowed)',
        );
      }
    },

    async emitInTx<E extends F8AuditEventType>(
      tx: unknown,
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // emitInTx MUST throw on any failure mode — caller relies on the
      // throw to roll back the surrounding state mutation (Principle VIII).
      // Both pre-flight enum checks throw explicitly here (NOT just via
      // pinoFallback's prod-only throw) so a misconfigured emit site
      // also rolls back atomically — the alternative (pinoFallback;
      // return) would silently commit the state mutation without an
      // audit row in dev/staging where pinoFallback warns rather than
      // throws, breaking the state↔audit invariant.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        throw new Error(
          `emitInTx: event type '${event.type}' is not a known F8 audit event — refusing to commit state mutation without atomic audit row`,
        );
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        throw new Error(
          `emitInTx: event type '${event.type}' is not yet in the audit_event_type pgEnum — ship its migration before atomic emit`,
        );
      }
      const txDb = tx as typeof db;
      await txDb.insert(auditLog).values(buildInsertValues(event, ctx));
    },
  };
}

