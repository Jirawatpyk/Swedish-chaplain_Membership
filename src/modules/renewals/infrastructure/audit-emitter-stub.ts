/**
 * Logging-only fallback emitter for F8 audit events.
 *
 * The composition root binds the **real** Drizzle adapter
 * (`drizzle-renewal-audit-emitter.ts`) which writes to `audit_log`
 * for events present in the `audit_event_type` pgEnum. This stub is
 * exported via the barrel for explicit opt-in in unit tests that
 * shouldn't touch the database, AND for transitional behaviour:
 * F8 events not yet in the pgEnum (still being added across phases)
 * fall through to `pinoFallback` in the real adapter — equivalent
 * pino-only logging behaviour to this stub.
 *
 * Pure Infrastructure — only `@/lib/logger` for observability.
 */
import { logger } from '@/lib/logger';
import {
  isF8AuditEventType,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditEventType,
  type RenewalAuditEmitter,
} from '../application/ports/renewal-audit-emitter';

/**
 * Production-mode guard.
 *
 * The composition root binds the real Drizzle adapter for production;
 * this stub is for unit tests + dev fallback only. If a future
 * composition wires this stub in production, the audit-trail
 * completeness invariant (Constitution Principle VIII) would silently
 * break — fail loud at first call to force the issue back to review.
 */
function assertNotProductionBeforeUse(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'F8 audit-emitter-stub invoked in production — composition root MUST bind ' +
        'the Drizzle adapter (drizzle-renewal-audit-emitter.ts) before flipping ' +
        'FEATURE_F8_RENEWALS=true.',
    );
  }
}

export const renewalAuditEmitterStub: RenewalAuditEmitter = {
  async emit<E extends F8AuditEventType>(
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void> {
    assertNotProductionBeforeUse();
    if (!isF8AuditEventType(event.type)) {
      logger.warn(
        { eventType: event.type, ctx },
        'F8 audit emit ignored — event type not in F8_AUDIT_EVENT_TYPES catalogue',
      );
      return;
    }
    logger.info(
      {
        f8AuditStub: true,
        eventType: event.type,
        tenantId: ctx.tenantId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        payload: event.payload,
      },
      'F8 audit emit (logging-only stub — real adapter writes to audit_log)',
    );
  },

  async emitInTx<E extends F8AuditEventType>(
    _tx: unknown,
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void> {
    // The real adapter writes to F1's audit_log inside the supplied tx
    // (atomic state+audit per Constitution Principle VIII). The stub
    // delegates to its own emit() — used only when the test / dev
    // composition explicitly opts out of DB writes.
    return this.emit(event, ctx);
  },

  async bulkEmitInTx(
    _tx: unknown,
    events: ReadonlyArray<F8AuditEvent<F8AuditEventType>>,
    baseCtx: AuditContext,
  ): Promise<void> {
    // Stub fans out via the per-event emit path so test runs see one
    // log entry per event (matches the real Drizzle adapter's bulk
    // INSERT … VALUES behaviour at the row level).
    for (const event of events) {
      await this.emit(event, baseCtx);
    }
  },
};
