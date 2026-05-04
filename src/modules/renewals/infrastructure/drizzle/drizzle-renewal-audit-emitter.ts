/**
 * F8 Phase 3 Wave H1 · T062 — Drizzle audit-emitter for F8 events.
 *
 * Replaces the Wave G `audit-emitter-stub.ts` for the **5 F8 event
 * types** that are present in the `audit_event_type` Postgres enum
 * (migration 0095). Un-shipped events fall through to the pino-logging
 * stub so a misconfigured emit site never silently drops audit data.
 *
 * Event types currently in pgEnum (Wave C-8 / migration 0095):
 *   - renewal_cycle_created
 *   - renewal_cycle_cancelled
 *   - renewal_cycle_completed_offline
 *   - renewal_cross_tenant_probe
 *   - f8_role_violation_blocked
 *
 * Subsequent enum-extension migrations (Phase 4+) will widen this list
 * as use-cases ship; this adapter is forward-compatible — adding a new
 * event-type to the const set below + the migration is enough.
 *
 * Behaviour:
 *   - `emit(event, ctx)`: opens its own runInTenant tx, writes to
 *     audit_log. Used by fire-and-forget side-effects (probe audits).
 *   - `emitInTx(tx, event, ctx)`: writes inside the supplied tx so
 *     state+audit commit atomically (Constitution Principle VIII).
 *
 * NULL retention_years column lets the DB-level trigger (migration
 * 0055/0063) apply the F8 default of 5 years — we don't override.
 */
import { sql } from 'drizzle-orm';
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
 * F8 event types whose pgEnum value exists today (migration 0095).
 * Other F8 events fall through to pino-logging stub until their
 * enum-extension migration ships in Phase 4+.
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

// Suppress unused-import lint — `sql` is reserved for future SQL
// expressions (e.g. `sql\`now()\`` retention overrides).
void sql;
