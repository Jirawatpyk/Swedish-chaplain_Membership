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
  AUDIENCE_AUDIT_LOCK_TIMEOUT_MS,
  AuditPortInvariantError,
  f7RetentionFor,
  type AudienceDeletedEmitInput,
  type AuditEmitInput,
  type AuditPort,
  type F7AuditPayloadShapes,
  type TypedAuditEmitInput,
} from '../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';
import { assertAudienceAuditTenantBoundTx, setLocalLockTimeout } from './db/drizzle-broadcasts-repo';

export const f7AuditAdapter: AuditPort = {
  async emit(txUnknown: unknown, event: AuditEmitInput): Promise<void> {
    // Mutation-path invariant: a non-null tx MUST carry a non-null
    // tenantId. RLS is bound on the tx's connection — emitting an
    // audit row with tenant_id=NULL inside a tenant-bound tx would
    // either be silently rejected by FORCE RLS or land the row in the
    // wrong RLS slice. Fail fast at the adapter so the bug surfaces at
    // the call site, not in a downstream RLS audit log scan.
    if (txUnknown !== null && event.tenantId === null) {
      // F7.1b B3 closure 2026-05-21: use tagged class for instanceof
      // discrimination; keep the same message body so log scans + the
      // legacy `f7AuditAdapter:`-prefix back-compat check continue to
      // work during the migration window.
      throw new AuditPortInvariantError(
        event.eventType,
        `mutation tx requires non-null tenantId. Use tx=null for system audits.`,
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

  /**
   * ROUND-2 R-M6 — the same INSERT with N VALUES tuples.
   *
   * Same invariant as `emit`: a non-null tx MUST carry a non-null tenantId,
   * checked per row so a single bad event in a batch fails at the call site
   * rather than landing the whole batch in the wrong RLS slice. An empty
   * batch issues no statement at all (`INSERT … VALUES` with nothing is a
   * syntax error, and there is nothing to write).
   */
  async emitMany(txUnknown: unknown, events: readonly AuditEmitInput[]): Promise<void> {
    await insertAuditRows(txUnknown, events);
  },

  /**
   * F119 — typed counterpart of `emitMany`, exactly as `emitTyped` is of
   * `emit`: the payload is constrained at the call site, the INSERT is the
   * same one statement.
   */
  async emitManyTyped<E extends keyof F7AuditPayloadShapes>(
    txUnknown: unknown,
    events: readonly TypedAuditEmitInput<E>[],
  ): Promise<void> {
    await insertAuditRows(txUnknown, events as readonly AuditEmitInput[]);
  },

  /**
   * Spec 142 (AO2) — the `broadcast_audience_deleted` row, at most once per
   * (tenant, segment); see the port docblock.
   *
   * The conflict target and its WHERE are literal SQL, never parameters: with
   * a bound `event_type` Postgres cannot prove the index predicate and answers
   * 42P10. The VALUES row stays parameterised, except `event_type`, which is
   * this method's only event. Unlike the invoicing overdue adapter, nothing is
   * swallowed: a lost row must reach the caller's ERROR and counter.
   *
   * Every refusal is an `AuditPortInvariantError` raised before any write: a
   * null tx (a pool connection carries no `app.current_tenant`), a null
   * `tenantId` or an empty segment id (a NULL key never conflicts, so either
   * would allow duplicates), another event type (a cast past the input type),
   * or a tx bound to another tenant (`assertAudienceAuditTenantBoundTx`).
   */
  async emitOnce(txUnknown: unknown, event: AudienceDeletedEmitInput): Promise<boolean> {
    if (txUnknown === null || txUnknown === undefined) {
      throw new AuditPortInvariantError('broadcast_audience_deleted', "emitOnce requires the caller's tenant-bound tx.");
    }
    if ((event.eventType as string) !== 'broadcast_audience_deleted') {
      throw new AuditPortInvariantError(event.eventType, 'emitOnce writes broadcast_audience_deleted only.');
    }
    if ((event.tenantId as string | null) === null) {
      throw new AuditPortInvariantError(event.eventType, 'emitOnce requires a non-null tenantId.');
    }
    const resendAudienceId = (event.payload as { readonly resend_audience_id?: unknown }).resend_audience_id;
    if (typeof resendAudienceId !== 'string' || resendAudienceId.length === 0) {
      throw new AuditPortInvariantError(event.eventType, 'emitOnce requires a non-empty resend_audience_id.');
    }
    const tx = txUnknown as TenantTx;
    await assertAudienceAuditTenantBoundTx(tx, event.tenantId, 'emitOnce', 'broadcast_audience_deleted');
    // The INSERT waits on another tx's uncommitted insert of the same key.
    await setLocalLockTimeout(tx, AUDIENCE_AUDIT_LOCK_TIMEOUT_MS, 'emitOnce');
    const rows = (await tx.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        ('broadcast_audience_deleted'::audit_event_type,
         ${event.actorUserId},
         ${event.summary},
         ${event.requestId ?? 'no-request-id'},
         ${JSON.stringify(event.payload)}::jsonb,
         ${event.tenantId},
         ${f7RetentionFor('broadcast_audience_deleted')})
      ON CONFLICT (tenant_id, (payload->>'resend_audience_id')) WHERE event_type = 'broadcast_audience_deleted' DO NOTHING RETURNING 1
    `)) as unknown as readonly unknown[];
    return rows.length === 1;
  },
};

/**
 * ROUND-2 R-M6 — the multi-row INSERT behind `emitMany` / `emitManyTyped`.
 */
async function insertAuditRows(txUnknown: unknown, events: readonly AuditEmitInput[]): Promise<void> {
  if (events.length === 0) return;
  for (const event of events) {
    if (txUnknown !== null && event.tenantId === null) {
      throw new AuditPortInvariantError(
        event.eventType,
        `mutation tx requires non-null tenantId. Use tx=null for system audits.`,
      );
    }
  }

  const tx = (txUnknown as TenantTx | null) ?? db;
  const rows = events.map(
    (event) => sql`(
      ${event.eventType}::audit_event_type,
      ${event.actorUserId},
      ${event.summary},
      ${event.requestId ?? 'no-request-id'},
      ${JSON.stringify(event.payload)}::jsonb,
      ${event.tenantId},
      ${f7RetentionFor(event.eventType)}
    )`,
  );

  await tx.execute(sql`
    INSERT INTO audit_log
      (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
    VALUES ${sql.join(rows, sql`, `)}
  `);
}
