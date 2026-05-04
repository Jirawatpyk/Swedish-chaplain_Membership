/**
 * F8 Phase 2 Wave G · T054 · part 4 — placeholder `RenewalAuditEmitter`.
 *
 * Wave G ships a logging-only stub that:
 *   - Validates `event.type` against the F8 audit-event catalogue
 *     (compile-time via the port's discriminated union; runtime via
 *     `isF8AuditEventType`).
 *   - Logs the event payload at `info` level via the project pino
 *     instance — useful during Phase 2 exit smoke tests where wiring
 *     is exercised but no use-case calls `emit()` for real.
 *   - DOES NOT write to `audit_log` because most F8 events are NOT yet
 *     in the Postgres `audit_event_type` pgEnum (Wave C-8 added only 5
 *     of the 54; the rest land in subsequent migrations alongside the
 *     emit sites in Phase 5+ user-story phases).
 *
 * The real adapter lands in Phase 5+ when:
 *   1. Subsequent enum-extension migrations add the remaining 49
 *      F8 event types to `audit_event_type`.
 *   2. Use-case adapters call `emit` / `emitInTx` from inside their
 *      `runInTenant` blocks per Constitution Principle VIII (atomic
 *      state+audit).
 *
 * Pure Infrastructure — only `@/lib/logger` import for observability.
 */
import { logger } from '@/lib/logger';
import {
  isF8AuditEventType,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditEventType,
  type RenewalAuditEmitter,
} from '../application/ports/renewal-audit-emitter';

const PHASE_2_STUB_LOG_LEVEL = 'info' as const;

export const renewalAuditEmitterStub: RenewalAuditEmitter = {
  async emit<E extends F8AuditEventType>(
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void> {
    if (!isF8AuditEventType(event.type)) {
      logger.warn(
        { eventType: event.type, ctx },
        'F8 audit emit ignored — event type not in F8_AUDIT_EVENT_TYPES catalogue',
      );
      return;
    }
    logger[PHASE_2_STUB_LOG_LEVEL](
      {
        f8AuditStub: true,
        eventType: event.type,
        tenantId: ctx.tenantId,
        actorRole: ctx.actorRole,
        correlationId: ctx.correlationId,
        payload: event.payload,
      },
      'F8 audit emit (Phase 2 stub — real adapter ships in Phase 5+)',
    );
  },

  async emitInTx<E extends F8AuditEventType>(
    _tx: unknown,
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void> {
    // Same Phase 2 behaviour as `emit` — Phase 5+ adapter writes to
    // F1's audit_log inside the supplied tx (atomic state+audit per
    // Constitution Principle VIII).
    return this.emit(event, ctx);
  },
};
