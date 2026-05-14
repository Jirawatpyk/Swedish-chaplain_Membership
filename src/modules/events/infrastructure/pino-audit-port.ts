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
 * failure, the emitter ALSO writes a `pino.fatal(...)` line — Vercel
 * Fluid Compute captures pino runtime logs (default destination
 * stdout) even when the DB is unreachable, so the rollback is NEVER
 * invisible at the observability layer. The pino call is wrapped in
 * try/catch — a write failure does NOT crash the handler.
 *
 * Pino redaction: payload fields are sanitised by the pino redact list
 * configured in `src/lib/logger.ts` (T002 added F6 secret fields).
 */
import { sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { TENANT_SLUG_PATTERN } from '@/modules/tenants';
import type {
  F6AuditPort,
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../application/ports/audit-port';
import type { AuditEventId } from '@/modules/auth';
import { sanitizeDbErrorMessage } from './sanitize-db-error';

/**
 * Phase 6 staff-review-4 WARN-1 — single dispatcher that maps a freshly
 * committed F6 audit row to its matching OTel counter (declared in
 * `eventcreateMetrics`). Called after `insertAuditRow` resolves so the
 * counter only fires when the audit row is actually persisted —
 * matches the H3 dashboard-truth pattern from Phase 5 round 3.
 *
 * Counter dimensions:
 *   - `plan_tier` for decrement counters is currently 'unknown' because
 *     the F6 audit payloads don't carry the F2 plan tier. PERF-05 (Phase
 *     10 follow-up) will extend `PlanAllotments` to thread the tier
 *     label through `queryAllotments` and into the audit payload.
 *   - `scope` for over-quota + credit-back counters reads from
 *     `entry.payload.scope` (always present per audit-port.ts payload
 *     types — `'partnership' | 'cultural'`).
 *
 * Wrapped in try/catch — metric emission failure must not propagate to
 * the Result chain (audit row already committed; partial observability
 * is acceptable; the metric layer is best-effort).
 */
function emitMatchingQuotaMetric(entry: F6AuditEntry): void {
  try {
    const tenantId = String(entry.tenantId);
    switch (entry.eventType) {
      case 'quota_partnership_decremented':
        eventcreateMetrics.quotaPartnershipDecremented(tenantId, null);
        break;
      case 'quota_cultural_decremented':
        eventcreateMetrics.quotaCulturalDecremented(tenantId, null);
        break;
      case 'quota_over_quota_warning': {
        const scope = (entry.payload as { scope?: string } | null)?.scope;
        if (scope === 'partnership' || scope === 'cultural') {
          eventcreateMetrics.quotaOverQuotaWarning(tenantId, scope);
        }
        break;
      }
      case 'quota_credit_back_refund': {
        const scope = (entry.payload as { scope?: string } | null)?.scope;
        if (scope === 'partnership' || scope === 'cultural') {
          eventcreateMetrics.quotaCreditBack(tenantId, 'refund', scope);
        }
        break;
      }
      case 'quota_credit_back_archive': {
        const scope = (entry.payload as { scope?: string } | null)?.scope;
        if (scope === 'partnership' || scope === 'cultural') {
          eventcreateMetrics.quotaCreditBack(tenantId, 'archive', scope);
        }
        break;
      }
      // quota_credit_back_relink reserved for future use-case (F6.1
      // re-matching surface). Falls through silently.
      default:
        // Non-quota audit events — handled by other metric paths
        // (webhookReceiptsTotal, webhookSecretRotated, etc.) or
        // intentionally counter-less.
        break;
    }
  } catch (e) {
    // Defensive — `eventcreateMetrics.*` already wraps in `safeMetric`,
    // but a guard here ensures no metric exception leaks into the
    // calling tx context. Logged at warn so operators see drift.
    logger.warn(
      {
        event: 'f6_quota_metric_emit_failed',
        eventType: entry.eventType,
        tenantId: String(entry.tenantId),
        err:
          e instanceof Error
            ? { name: e.name, message: e.message }
            : { name: 'non_error', message: String(e) },
      },
      'F6 quota metric emit failed — audit row was persisted but OTel counter did not increment',
    );
  }
}

/**
 * F6 default retention — 5 years. No tax-document overlap (F4's 10y
 * retention does not apply to F6 events).
 */
export const F6_DEFAULT_RETENTION_YEARS = 5 as const;

/**
 * Cap + sanitize DB error messages before they reach the audit Result
 * payload. Postgres errors include table names, column names,
 * constraint names that should not leak through the Application layer.
 * Defense-in-depth alongside pino REDACT_PATHS.
 *
 * IMPORTANT: this strips for the OUTBOUND payload only. The full error
 * (with stack) is logged via `logger.error` at the catch site BEFORE
 * sanitisation so SREs can debug root causes server-side.
 */
/**
 * Preserve full error info (name + message + stack) in a structured log
 * line BEFORE the sanitised Result is returned to Application. Pairs
 * with `sanitizeDbErrorMessage` — sanitisation protects the outbound
 * payload (audit row stays clean of PG identifiers); this log keeps
 * the root cause server-side for SRE debugging.
 */
function logFullError(
  context: { caller: string; tenantId: string; eventType: string },
  e: unknown,
): void {
  logger.error(
    {
      event: 'f6_audit_emit_db_error',
      caller: context.caller,
      tenantId: context.tenantId,
      eventType: context.eventType,
      err:
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : { name: 'non_error', message: String(e), stack: null },
    },
    '[F6] audit row insert failed (full error preserved server-side; sanitised copy returned to caller)',
  );
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
 *
 * R009 (staff-review fix 2026-05-13): namespace all F6 sentinels with
 * a `system:f6-*` prefix, matching the precedent already established
 * across the codebase (`system:bootstrap`, `system:cron`,
 * `system:test`, `system:stripe-webhook`). The previous bare values
 * (`'system'` / `'zapier_webhook'` / `'csv_import'`) risked colliding
 * with real user_id strings stored as text in `audit_log.actor_user_id`
 * by other features, making SRE dashboards filter on a single
 * `actor_user_id LIKE 'system:%'` predicate ambiguous. `cron:f6` is
 * upgraded to `system:f6-cron` for the same consistency reason.
 *
 * Forward-compat note: any dashboard or audit-query that filtered on
 * the OLD bare strings must be updated. No tests assert on these
 * exact values (audited in the same review pass), so the change is
 * code-only.
 */
function actorSentinel(entry: F6AuditEntry): string {
  switch (entry.actorType) {
    case 'system':
      return 'system:f6';
    case 'zapier_webhook':
      return 'system:f6-zapier-webhook';
    case 'csv_import':
      return 'system:f6-csv-import';
    case 'cron':
      return 'system:f6-cron';
    default:
      return 'system:f6';
  }
}

/**
 * Extract requestId from payload when present (webhook events carry it).
 * `audit_log.request_id` is NOT NULL — column requires a value, so a
 * `'no-request-id'` sentinel is returned when no payload field maps.
 *
 * Field-name dispatch:
 *   - All current webhook event types use `payload.requestId` —
 *     including `webhook_test_invoked` after Round-6 verify-fix
 *     2026-05-13 (type-design C2) renamed its previously-bespoke
 *     `testRequestId` field for naming-convention symmetry. The
 *     legacy `testRequestId` fallback below remains so old audit
 *     rows (emitted in dev/staging before the field-rename
 *     deployment) can still hydrate their request_id correctly when
 *     queried.
 *
 * If/when future event types add yet another field-name variant,
 * extend this dispatch — do NOT silently fall through to the sentinel.
 */
function extractRequestId(entry: F6AuditEntry): string {
  const payload = entry.payload as Record<string, unknown> | null;
  if (!payload) return 'no-request-id';
  if (typeof payload['requestId'] === 'string') {
    return payload['requestId'];
  }
  // Legacy fallback for `webhook_test_invoked` audit rows emitted
  // before Round-6 (type-design C2) renamed the field. Safe to
  // remove once all pre-2026-05-13 dev/staging audit rows are
  // expired beyond their retention window.
  if (typeof payload['testRequestId'] === 'string') {
    return payload['testRequestId'];
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
        // Phase 6 WARN-1 — fire matching OTel counter AFTER the audit
        // row commits in the caller's tx (the row commits on tx commit;
        // best-effort metric emission cannot block or fail the tx).
        emitMatchingQuotaMetric(entry);
        return ok(id as AuditEventId);
      } catch (e) {
        logFullError(
          { caller: 'emit', tenantId: entry.tenantId, eventType: entry.eventType },
          e,
        );
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
        // Belt-and-suspenders runtime regex guard on the raw GUC
        // interpolation below. This method is a standalone-tx path —
        // it uses root `db.transaction` directly instead of the
        // executor passed to `makePinoAuditPort`. Callers include the
        // `emitRolledBackStandalone` deps wrapper in `infrastructure/
        // di.ts` plus tests + future cron/replay paths. The canonical
        // `runInTenant` in `src/lib/db.ts` already enforces this slug
        // shape, but standalone callers bypass runInTenant — so an
        // unvalidated tenantId here would risk SQL injection via the
        // `SET LOCAL app.current_tenant = '${entry.tenantId}'` line.
        if (!TENANT_SLUG_PATTERN.test(entry.tenantId as unknown as string)) {
          throw new Error(
            `pino-audit-port emitRolledBack: tenantId slug invariant violated: ${entry.tenantId}`,
          );
        }
        const id = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE chamber_app`);
          await tx.execute(sql.raw(`SET LOCAL app.current_tenant = '${entry.tenantId}'`));
          return await insertAuditRow(tx, entry);
        });
        return ok(id as AuditEventId);
      } catch (e) {
        logFullError(
          { caller: 'emitRolledBack', tenantId: entry.tenantId, eventType: entry.eventType },
          e,
        );
        // Dual-write fallback per research.md R6 — DB is unreachable or
        // the row insert failed. Surface via pino.fatal so Vercel Fluid
        // Compute captures the rollback marker even when the DB is
        // fully down. Wrapped in try/catch + last-ditch raw stderr
        // write so an outright pino crash still leaves a forensic
        // breadcrumb.
        try {
          logger.fatal(
            {
              event: 'webhook_rolled_back',
              tenantId: entry.tenantId,
              audit_secondary_tx_failure: true,
              payload: entry.payload,
              dbErrorMessage: sanitizeDbErrorMessage(e),
            },
            '[F6] webhook_rolled_back audit secondary-tx failure — payload preserved per FR-037 dual-write fallback',
          );
        } catch {
          try {
            // Sanitise tenantId — it may have failed the slug guard
            // above and contain control chars / newlines that would
            // split the forensic log line in downstream aggregators.
            const safeTenant = String(entry.tenantId).replace(/[^a-z0-9-]/gi, '?').slice(0, 63);
            process.stderr.write(
              `[F6 LAST-DITCH] webhook_rolled_back audit_double_failure tenant=${safeTenant}\n`,
            );
          } catch {
            /* truly nothing left */
          }
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
      // Generic standalone-tx emit for events NOT inside a use-case
      // strict-tx (currently: `webhook_signature_rejected` from the
      // route handler). Same dual-write fallback semantics as
      // `emitRolledBack` but accepts any F6 event type.
      try {
        if (!TENANT_SLUG_PATTERN.test(entry.tenantId as unknown as string)) {
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
        logFullError(
          { caller: 'emitStandalone', tenantId: entry.tenantId, eventType: entry.eventType },
          e,
        );
        try {
          logger.fatal(
            {
              event: entry.eventType,
              tenantId: entry.tenantId,
              audit_secondary_tx_failure: true,
              payload: entry.payload,
              dbErrorMessage: sanitizeDbErrorMessage(e),
            },
            `[F6] ${entry.eventType} audit secondary-tx failure — payload preserved per FR-037 dual-write fallback`,
          );
        } catch {
          try {
            const safeTenant = String(entry.tenantId).replace(/[^a-z0-9-]/gi, '?').slice(0, 63);
            const safeEventType = String(entry.eventType).replace(/[^a-z0-9_]/gi, '?').slice(0, 64);
            process.stderr.write(
              `[F6 LAST-DITCH] ${safeEventType} audit_double_failure tenant=${safeTenant}\n`,
            );
          } catch {
            /* truly nothing left */
          }
        }
        return err({
          kind: 'db_error',
          message: sanitizeDbErrorMessage(e),
        });
      }
    },
  };
}
