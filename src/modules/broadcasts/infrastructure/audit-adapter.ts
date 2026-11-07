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
 *
 * Spec 142: `emitOnce` (the `broadcast_audience_deleted` row) takes no null tx;
 * it refuses one with `AuditPortInvariantError`. It is that row's only writer:
 * `emit`, `emitTyped` and the multi-row methods refuse the event before any
 * write (review round 1, code-review #3), so no path bypasses the index.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  AUDIENCE_AUDIT_LOCK_TIMEOUT_MS,
  AuditPortInvariantError,
  f7RetentionFor,
  type AudienceDeletedAuditPort,
  type AudienceDeletedEmitInput,
  type AuditEmitInput,
  type AuditPort,
  type F7EmitTypedEventType,
  type TypedAuditEmitInput,
} from '../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';
import { AUDIENCE_DELETED_KEY_SQL, AUDIENCE_DELETED_PREDICATE_SQL } from './db/audience-audit-index';
import { assertAudienceAuditTenantBoundTx, setLocalLockTimeout } from './db/drizzle-broadcasts-repo';

/** Spec 142 (review round 1, CR #7) — the F7 adapter implements both audit ports. */
export type F7AuditAdapter = AuditPort & AudienceDeletedAuditPort;

export const f7AuditAdapter: F7AuditAdapter = {
  async emit(txUnknown: unknown, event: AuditEmitInput): Promise<void> {
    refuseAudienceDeletedRow(event.eventType);
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
    await tx.execute(sql`INSERT INTO audit_log ${AUDIT_LOG_COLUMNS} VALUES ${auditRowValues(event)}`);
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
  async emitTyped<E extends F7EmitTypedEventType>(
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
  async emitManyTyped<E extends F7EmitTypedEventType>(
    txUnknown: unknown,
    events: readonly TypedAuditEmitInput<E>[],
  ): Promise<void> {
    await insertAuditRows(txUnknown, events as readonly AuditEmitInput[]);
  },

  /**
   * Spec 142 (AO2) — the `broadcast_audience_deleted` row, at most once per
   * (tenant, segment); see the `AudienceDeletedAuditPort` docblock.
   *
   * The conflict target and its WHERE are literal SQL, never parameters: with
   * a parameter there Postgres cannot prove the index predicate and answers
   * 42P10. Spec 143 (TT1): both are migration 0328's key and predicate from
   * `audience-audit-index.ts`, spliced with `sql.raw`. The VALUES row is bound like every other writer's, `event_type`
   * included (review round 2, code-review #6): index inference reads only the
   * conflict clause. Unlike the invoicing overdue adapter, nothing is
   * swallowed: a lost row must reach the caller's ERROR and counter.
   *
   * Every refusal is an `AuditPortInvariantError` raised before any write: a
   * null tx (a pool connection carries no `app.current_tenant`), a null
   * `tenantId` or an empty segment id (a NULL key never conflicts, so either
   * would allow duplicates), another event type (a cast past the input type),
   * or a tx bound to another tenant (`assertAudienceAuditTenantBoundTx`). That
   * check is the repo's own, so it shares the repo's per-tx proof: after the
   * reclaim's disclosure read on the same tx and tenant it runs no second
   * probe (spec 143 TT3).
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
      INSERT INTO audit_log ${AUDIT_LOG_COLUMNS}
      VALUES ${auditRowValues(event)}
      ON CONFLICT ${sql.raw(AUDIENCE_DELETED_KEY_SQL)} WHERE ${sql.raw(AUDIENCE_DELETED_PREDICATE_SQL)} DO NOTHING RETURNING 1
    `)) as unknown as readonly unknown[];
    return rows.length === 1;
  },
};

/**
 * Spec 142 (review round 1, code-review #6) — the one column list and the one
 * row builder of every adapter INSERT, so the defaults (`no-request-id`, the
 * F7 retention, the jsonb payload) exist once. Every value is bound, the
 * `event_type` of `emitOnce` included (review round 2, code-review #6).
 */
const AUDIT_LOG_COLUMNS = sql`(event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)`;

/** Spec 142 (review round 2, code-review #7) — a row is one of the two port inputs. */
type AuditRowFields = AuditEmitInput | AudienceDeletedEmitInput;

function auditRowValues(event: AuditRowFields): SQL {
  return sql`(${event.eventType}::audit_event_type, ${event.actorUserId}, ${event.summary}, ${event.requestId ?? 'no-request-id'},
    ${JSON.stringify(event.payload)}::jsonb, ${event.tenantId}, ${f7RetentionFor(event.eventType)})`;
}

/**
 * Spec 142 (review round 1, code-review #3) — `broadcast_audience_deleted` is
 * written only through `emitOnce`, whose `ON CONFLICT` is the dedupe. A plain
 * INSERT of it bypasses that dedupe: a second row meets the index as a 23505,
 * which the row helper logs as a lost row. So every other method refuses it
 * before any write; `emitTyped` reaches this through `emit`. The port's types
 * exclude the event (review round 2); this catches a cast past them, so it
 * takes the event type as a plain string.
 */
function refuseAudienceDeletedRow(eventType: string): void {
  if (eventType === 'broadcast_audience_deleted') {
    throw new AuditPortInvariantError(eventType, 'written only through emitOnce (migration 0328).');
  }
}

/**
 * ROUND-2 R-M6 — the multi-row INSERT behind `emitMany` / `emitManyTyped`.
 */
async function insertAuditRows(txUnknown: unknown, events: readonly AuditEmitInput[]): Promise<void> {
  if (events.length === 0) return;
  for (const event of events) {
    refuseAudienceDeletedRow(event.eventType);
    if (txUnknown !== null && event.tenantId === null) {
      throw new AuditPortInvariantError(
        event.eventType,
        `mutation tx requires non-null tenantId. Use tx=null for system audits.`,
      );
    }
  }

  const tx = (txUnknown as TenantTx | null) ?? db;
  const rows = events.map((event) => auditRowValues(event));
  await tx.execute(sql`INSERT INTO audit_log ${AUDIT_LOG_COLUMNS} VALUES ${sql.join(rows, sql`, `)}`);
}
