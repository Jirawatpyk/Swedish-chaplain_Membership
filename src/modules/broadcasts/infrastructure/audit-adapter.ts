/**
 * F7 audit adapter — mirrors the F4 implementation pattern.
 *
 * Inserts into the `audit_log` table with an F7 event_type, the tenant
 * slug, structured payload, and explicit retention_years (always 5y for
 * F7 — no tax-document overlap). Reuses the F1/F2/F3/F4 audit
 * infrastructure (same `audit_log` table, same `audit_event_type`
 * enum extended by migration 0072).
 *
 * `tx` semantics:
 *   - non-null Drizzle tx → atomic with the caller's mutation
 *   - null tx → standalone INSERT on `db` (auto-commit), used for
 *     read-path probe audits (cross-tenant) where the outer path is
 *     read-only. Trail is best-effort: if the standalone INSERT fails,
 *     caller logs + continues — does NOT 5xx the request.
 */
import { sql } from 'drizzle-orm';
import {
  f7RetentionFor,
  type AuditEmitInput,
  type AuditPort,
  type F7AuditPayloadShapes,
  type TypedAuditEmitInput,
} from '../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';

export const f7AuditAdapter: AuditPort = {
  async emit(txUnknown: unknown, event: AuditEmitInput): Promise<void> {
    // Mutation-path invariant: a non-null tx MUST carry a non-null
    // tenantId. RLS is bound on the tx's connection — emitting an
    // audit row with tenant_id=NULL inside a tenant-bound tx would
    // either be silently rejected by FORCE RLS or land the row in the
    // wrong RLS slice. Fail fast at the adapter so the bug surfaces at
    // the call site, not in a downstream RLS audit log scan.
    if (txUnknown !== null && event.tenantId === null) {
      throw new Error(
        `f7AuditAdapter: mutation tx requires non-null tenantId ` +
          `(eventType=${event.eventType}). Use tx=null for system audits.`,
      );
    }

    const tx = (txUnknown as TenantTx | null) ?? db;
    const requestId = event.requestId ?? 'no-request-id';
    const retentionYears = f7RetentionFor(event.eventType);

    await tx.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        (${event.eventType}::audit_event_type,
         ${event.actorUserId},
         ${event.summary},
         ${requestId},
         ${JSON.stringify(event.payload)}::jsonb,
         ${event.tenantId},
         ${retentionYears})
    `);
  },
  /**
   * R4.3 M-15 — typed counterpart of `emit`. At runtime the two paths
   * are indistinguishable; the only difference is the call-site type
   * narrowing (payload constrained by `F7AuditPayloadShapes[E]`).
   * Forward the typed input through the wide-payload INSERT.
   *
   * R6.2 M-2 — dispatch via `this.emit(...)` instead of the module-
   * level binding `f7AuditAdapter.emit(...)`. The dynamic dispatch
   * lets future audit-pipeline middleware wrap the adapter via
   * `Object.create(f7AuditAdapter)` + override `emit`, and have
   * `emitTyped` route through the wrapper's overridden method. The
   * 2 production call sites use `deps.audit.emitTyped(tx, event)`
   * which preserves the receiver binding; no destructuring exists.
   */
  async emitTyped<E extends keyof F7AuditPayloadShapes>(
    txUnknown: unknown,
    event: TypedAuditEmitInput<E>,
  ): Promise<void> {
    await this.emit(txUnknown, event as AuditEmitInput);
  },
};
