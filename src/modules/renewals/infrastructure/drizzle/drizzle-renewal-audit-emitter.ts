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
 * F8 event types whose pgEnum value exists today (migrations 0095 +
 * 0099). Add to this set + ship a corresponding `ALTER TYPE … ADD VALUE`
 * migration when wiring a new emit site. Events not in this set fall
 * through to pino-logging (loud-fail in production).
 */
const F8_ENUM_SHIPPED: ReadonlySet<F8AuditEventType> = new Set([
  'renewal_cycle_created',
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
  logger.info(
    {
      f8AuditFallthrough: true,
      reason,
      eventType: event.type,
      tenantId: ctx.tenantId,
      actorRole: ctx.actorRole,
      correlationId: ctx.correlationId,
      payload: event.payload,
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
    // values after migration 0095. Cast through the canonical enum
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
      // Wrap the WHOLE body — including the production-mode guard
      // inside pinoFallback — in try/catch so emit() truly never
      // throws to the caller (port contract: fire-and-forget).
      // emitInTx remains throw-on-fail (Principle VIII tx rollback).
      try {
        if (!isF8AuditEventType(event.type)) {
          pinoFallback(event, ctx, 'unknown_event_type');
          return;
        }
        if (!F8_ENUM_SHIPPED.has(event.type)) {
          pinoFallback(event, ctx, 'not_in_pgenum');
          return;
        }
        await runInTenant(tenant, async (tx) => {
          await tx.insert(auditLog).values(buildInsertValues(event, ctx));
        });
      } catch (e) {
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            eventType: event.type,
            tenantId: ctx.tenantId,
          },
          'F8 audit emit failed (fire-and-forget swallowed)',
        );
      }
    },

    async emitInTx<E extends F8AuditEventType>(
      tx: unknown,
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        return;
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        return;
      }
      // emitInTx MUST throw on failure — caller relies on the throw
      // to roll back the surrounding state mutation (Principle VIII).
      const txDb = tx as typeof db;
      await txDb.insert(auditLog).values(buildInsertValues(event, ctx));
    },
  };
}

