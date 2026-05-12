/**
 * T051 — F6 audit emitter (Infrastructure).
 *
 * Implements `F6AuditPort` per contracts/audit-port.md. Writes structured
 * F6 audit events to F1's shared `audit_log` table (extended by F2
 * migration 0007 with `payload jsonb` + `tenant_id text`; extended by
 * F5 migration 0038 with `retention_years smallint`; extended by F6
 * migration 0132 with 35 new enum values).
 *
 * tx semantics (mirror F4/F5):
 *   - `emit(entry)` — writes inside the CALLER'S transaction (executor
 *     is the TenantTx). Atomic with the use-case's side effects so the
 *     audit row commits together with the state change OR rolls back
 *     together.
 *   - `emitRolledBack(entry)` — writes in a SEPARATE transaction on the
 *     root `db` connection. This is the FR-037 strict-tx fallback —
 *     invoked AFTER the primary ACID unit has rolled back so the
 *     audit row commits even when the main work failed.
 *
 * Dual-write fallback (research.md R6): on `emitRolledBack` DB-write
 * failure, the emitter ALSO writes a `pino.fatal(...)` line to stderr
 * with `audit_secondary_tx_failure: true`. Vercel Fluid Compute captures
 * stderr as runtime logs even when the DB is unreachable, so the
 * rollback is NEVER invisible at the observability layer. The pino
 * call is wrapped in try/catch — a stderr write failure does NOT crash
 * the handler.
 *
 * Pino redaction: payload fields are sanitised by the pino redact list
 * configured in `src/lib/logger.ts` (T002 added F6 secret fields).
 */
import { sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type {
  F6AuditPort,
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../application/ports/audit-port';
import type { AuditEventId } from '@/modules/auth';

/**
 * F6 default retention — 5 years. No tax-document overlap (F4's 10y
 * retention does not apply to F6 events).
 */
export const F6_DEFAULT_RETENTION_YEARS = 5 as const;

/**
 * Issue I-FULL-7 (review 2026-05-12) — cap + sanitize DB error messages
 * before they reach pino.fatal stdout. Postgres errors include table
 * names, column names, constraint names that should not leak to runtime
 * logs. Defense-in-depth alongside pino REDACT_PATHS.
 */
const DB_ERROR_MESSAGE_CAP = 200;

function sanitizeDbErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Strip Postgres "context" lines that often include identifiers
  const stripped = raw
    .replace(/(table|column|constraint|relation|function|index|sequence|schema)\s+"[^"]+"/gi, '$1 "[redacted]"')
    .replace(/(table|column|constraint|relation|function|index|sequence|schema)\s+[a-z_][a-z0-9_]*/gi, '$1 [redacted]');
  return stripped.slice(0, DB_ERROR_MESSAGE_CAP);
}

async function insertAuditRow(
  executor: TenantTx | typeof db,
  entry: F6AuditEntry,
): Promise<string> {
  // Use raw SQL because the Drizzle `auditLog` schema does not include
  // `retention_years` (F5 migration 0038) AND its pgEnum type does not
  // reflect the F6 enum extensions (migration 0132). Casting at SQL
  // level ensures the enum value is accepted by Postgres.
  const result = await executor.execute(sql`
    INSERT INTO audit_log
      (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
    VALUES
      (${entry.eventType}::audit_event_type,
       ${entry.actorUserId ?? actorSentinel(entry)},
       ${entry.summary},
       ${extractRequestId(entry)},
       ${JSON.stringify(entry.payload)}::jsonb,
       ${entry.tenantId},
       ${F6_DEFAULT_RETENTION_YEARS})
    RETURNING id
  `);
  // postgres-js returns Iterable<Record<string, unknown>>; first row's id
  // is the generated UUID. Result shape: typeof result implements
  // ArrayLike<Record<...>>.
  const rows = result as unknown as ReadonlyArray<{ id: string }>;
  const first = rows[0];
  if (!first?.id) {
    throw new Error('audit insert returned no id');
  }
  return first.id;
}

/**
 * actor_user_id sentinel — F6 audit envelopes carry `actorType` which
 * for non-human contexts (zapier_webhook / csv_import / cron / system)
 * maps to a stable string. The audit_log table requires NOT NULL on
 * `actor_user_id`, so we always emit a value.
 */
function actorSentinel(entry: F6AuditEntry): string {
  switch (entry.actorType) {
    case 'system':
      return 'system';
    case 'zapier_webhook':
      return 'zapier_webhook';
    case 'csv_import':
      return 'csv_import';
    case 'cron':
      return 'cron:f6';
    default:
      return 'system';
  }
}

/**
 * Extract requestId from payload when present (webhook events carry it).
 * `audit_log.request_id` is NOT NULL.
 */
function extractRequestId(entry: F6AuditEntry): string {
  const payload = entry.payload as Record<string, unknown> | null;
  if (payload && typeof payload['requestId'] === 'string') {
    return payload['requestId'];
  }
  return 'no-request-id';
}

/**
 * Production emitter — caller must provide the transaction handle so the
 * audit row commits atomically with the surrounding work. For the
 * separate-tx fallback (FR-037 rollback path), `emitRolledBack` uses the
 * root `db` connection internally.
 */
export function makePinoAuditPort(executor: TenantTx): F6AuditPort {
  return {
    async emit<T extends F6AuditEventType>(
      entry: F6AuditEntry<T>,
    ): Promise<Result<AuditEventId, AuditEmitError>> {
      try {
        const id = await insertAuditRow(executor, entry);
        return ok(id as AuditEventId);
      } catch (e) {
        return err({
          kind: 'db_error',
          message: sanitizeDbErrorMessage(e),
        });
      }
    },

    async emitRolledBack(
      entry: F6AuditEntry<'webhook_rolled_back'>,
    ): Promise<Result<AuditEventId, AuditEmitError>> {
      // Separate-tx path — use the ROOT db connection, not the (already
      // rolled-back) executor. Wrapped in its own transaction so a failure
      // here also rolls back cleanly without affecting anything else.
      try {
        // Issue I1 (review 2026-05-12) — belt-and-suspenders runtime
        // regex guard on the raw GUC interpolation below. The canonical
        // `runInTenant` in src/lib/db.ts already enforces this slug
        // shape, but `emitRolledBackStandalone` bypasses runInTenant
        // and goes directly through `db.transaction`. Without this
        // guard, a future caller (cron replay, retention sweep, etc.)
        // passing an unvalidated tenantId could trigger SQL injection
        // via the `SET LOCAL app.current_tenant = '${entry.tenantId}'`
        // line. Same pattern as runInTenant db.ts:231.
        if (!/^[a-z0-9-]{1,63}$/.test(entry.tenantId as unknown as string)) {
          throw new Error(
            `pino-audit-port emitRolledBack: tenantId slug invariant violated: ${entry.tenantId}`,
          );
        }
        const id = await db.transaction(async (tx) => {
          // RLS context: webhook_rolled_back rows MUST carry tenant_id so
          // tenant-scoped audit queries surface them; set the GUC for this
          // tx so RLS+FORCE allows the INSERT.
          await tx.execute(sql`SET LOCAL ROLE chamber_app`);
          await tx.execute(sql.raw(`SET LOCAL app.current_tenant = '${entry.tenantId}'`));
          return await insertAuditRow(tx, entry);
        });
        return ok(id as AuditEventId);
      } catch (e) {
        // Dual-write fallback per research.md R6 — DB is unreachable or
        // the row insert failed. Surface to stderr via pino.fatal so
        // Vercel Fluid Compute captures the rollback marker even when
        // the DB is fully down. Wrapped in try/catch so a stderr failure
        // does NOT crash the handler.
        try {
          logger.fatal(
            {
              event: 'webhook_rolled_back',
              tenantId: entry.tenantId,
              audit_secondary_tx_failure: true,
              payload: entry.payload,
              dbErrorMessage: sanitizeDbErrorMessage(e),
            },
            '[F6] webhook_rolled_back audit secondary-tx failure — payload preserved in stderr per FR-037 dual-write fallback',
          );
        } catch {
          // Stderr write failed too. Nothing more we can do; surface the
          // original DB error to the caller.
        }
        return err({
          kind: 'db_error',
          message: sanitizeDbErrorMessage(e),
        });
      }
    },

    async emitStandalone<T extends F6AuditEventType>(
      entry: F6AuditEntry<T>,
    ): Promise<Result<AuditEventId, AuditEmitError>> {
      // Issue C-FULL-2 (review 2026-05-12) — generic standalone-tx emit
      // for events NOT inside a use-case strict-tx (currently:
      // `webhook_signature_rejected` from the route handler). Same
      // dual-write fallback semantics as `emitRolledBack` but accepts
      // any F6 event type.
      try {
        if (!/^[a-z0-9-]{1,63}$/.test(entry.tenantId as unknown as string)) {
          throw new Error(
            `pino-audit-port emitStandalone: tenantId slug invariant violated: ${entry.tenantId}`,
          );
        }
        const id = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE chamber_app`);
          await tx.execute(sql.raw(`SET LOCAL app.current_tenant = '${entry.tenantId}'`));
          return await insertAuditRow(tx, entry);
        });
        return ok(id as AuditEventId);
      } catch (e) {
        try {
          logger.fatal(
            {
              event: entry.eventType,
              tenantId: entry.tenantId,
              audit_secondary_tx_failure: true,
              payload: entry.payload,
              dbErrorMessage: sanitizeDbErrorMessage(e),
            },
            `[F6] ${entry.eventType} audit secondary-tx failure — payload preserved in stderr per FR-037 dual-write fallback`,
          );
        } catch {
          // Stderr write failed too — degrade gracefully.
        }
        return err({
          kind: 'db_error',
          message: sanitizeDbErrorMessage(e),
        });
      }
    },
  };
}
