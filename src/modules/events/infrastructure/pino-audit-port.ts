/**
 * F6 audit emitter (Infrastructure).
 *
 * Implements `F6AuditPort` per contracts/audit-port.md. Writes structured
 * F6 audit events to F1's shared `audit_log` table (extended by F2
 * migration 0007 with `payload jsonb` + `tenant_id text`; extended by
 * F5 migration 0038 with `retention_years smallint`; extended by F6
 * migration 0132 with 35 new enum values, then further extended to a
 * canonical 43-event taxonomy via migrations 0135 + 0140-series F6.1
 * CSV + 0144 `event_created` + R6-W5 `webhook_ingest_precondition_failed`).
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
import { runInTenant, type Database, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import type {
  F6AuditPort,
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../application/ports/audit-port';
import type { AuditEventId } from '@/modules/auth';
import type { TenantId } from '@/modules/members';
import type { RegistrationId } from '../domain/branded-types';
import { sanitizeDbErrorMessage } from './sanitize-db-error';

/**
 * Phase 6 staff-review-4 WARN-1 — single dispatcher that maps a freshly
 * inserted F6 audit row to its matching OTel counter (declared in
 * `eventcreateMetrics`). Called after `insertAuditRow` returns so the
 * counter increments only when the row insert succeeded.
 *
 * **R6 PERF-R6-02 caveat (H3 dashboard-truth accuracy; R7 COMMENT-FR-03 corrected)**:
 * this dispatcher fires AFTER `insertAuditRow` resolves but BEFORE
 * the caller's transaction commits. If the surrounding tx later rolls
 * back (e.g., a later iteration in the archive loop emits an audit-
 * emit failure → `runInTenantWithRollbackOnErr` rolls the entire tx),
 * the audit row for THIS iteration is NOT persisted in `audit_log`,
 * but the OTel counter increment is NOT reversible. Drift is bounded
 * to **`≤ 2 × currentIteration`** phantom counter increments per
 * archive failure — EACH counted row can emit BOTH partnership AND
 * cultural credit-back audits (one per scope), and each emit fires
 * one OTel counter increment via this dispatcher. The drift is
 * observable via the accompanying `logger.error` on the error path.
 *
 * This is a deliberate trade-off matching the F5 payment-receipt +
 * F7 broadcast-delivery precedent — `audit_log` table is the
 * authoritative source of truth; OTel counters are best-effort
 * observability + can over-count by ≤1 per partial rollback. The
 * "commit together" claim in the original Phase 5 H3 comment was
 * over-precise; this docstring is the corrected version.
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
 * the Result chain (audit row insert succeeded; partial observability
 * is acceptable; the metric layer is best-effort).
 *
 * **R6 SUGG-R5-2 + PERF-R6-03 closure**: this dispatcher is now invoked
 * from BOTH `emit()` (caller's strict-tx path) AND `emitStandalone()`
 * (separate-tx path for events outside a use-case strict-tx). The
 * `emitRolledBack()` path is intentionally NOT wired because it only
 * handles `webhook_rolled_back` — never a quota event — and double-
 * invocation would be defensive but unnecessary at runtime.
 */
function emitMatchingQuotaMetric(entry: F6AuditEntry): void {
  try {
    const tenantId = String(entry.tenantId);
    switch (entry.eventType) {
      case 'quota_partnership_decremented': {
        // R6 PERF-05 closure — plan_tier label sourced from the audit
        // payload (threaded through queryAllotments → applyQuotaEffect
        // → audit emit). Falls back to null for legacy data; the
        // counter renders that as `plan_tier='unknown'`.
        const planTier = (entry.payload as { planTier?: string | null } | null)
          ?.planTier ?? null;
        eventcreateMetrics.quotaPartnershipDecremented(tenantId, planTier);
        break;
      }
      case 'quota_cultural_decremented': {
        const planTier = (entry.payload as { planTier?: string | null } | null)
          ?.planTier ?? null;
        eventcreateMetrics.quotaCulturalDecremented(tenantId, planTier);
        break;
      }
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

/**
 * Allowlist for {@link redactPayloadForFatalLog}.
 *
 * Organised by purpose so future maintainers can reason about each
 * field's forensic value vs PII-leak risk:
 *
 *   - Forensic context (always safe): severity, source, scope, requestId
 *   - Probe/attack signals (non-PII identifiers): sourceIp, attemptedRoute,
 *     probedTenantId, signedTenantId, probedId, probeSurface, probedAt
 *   - Signature failure details: signatureLastFour, timestampSkewSeconds,
 *     bodyLengthBytes
 *   - Operation outcomes: errorName, failureStage, stage, rowNumber,
 *     rowsCleared, durationMs
 *   - CSV import row counters: rowsProcessed, rowsAlreadyImported,
 *     rowsStateChanged, eventsCreated, eventsUpdated, errorRowCount,
 *     timedOut, sourceFormat
 *   - CSV import override forensics: recordId, currentEventId, overriddenAt
 *   - Identifiers (non-PII UUIDs): registrationId, eventId, matchType
 *   - Actor classification (non-PII role labels): actorType, actorUserId,
 *     dispatchedByActorUserId, dispatchedByActorRole, actorRole,
 *     attemptedAction, blockedAt
 *   - Cancellation forensics (already-hashed PII): attendeeEmailHash
 *   - State signals: graceSecretUsed, graceSecretAgeHours, reason
 *
 * Anything NOT on this list is dropped — protects against PII fields
 * like `attendeeEmail`, `attendeeName`, `attendeeCompany`, `errorMessage`,
 * `errorStack`, `reasonText`, `rawRowExcerpt`, `errors[]` reaching the
 * `pino.fatal` log when DB-write fails. Nested objects (e.g.
 * `matchCounts: Record<MatchType, number>`) and arrays (e.g.
 * `priorRecordIds`, `priorEventIds`) are also dropped — emit-site
 * pre-formatting to a primitive summary string is required if those
 * forensic primitives need to survive the fallback.
 *
 * Cross-checked against every in-tree `emitStandalone()` and
 * `emitRolledBack()` caller's payload fields as of Round-3 audit (see
 * `tests/unit/events/infrastructure/redact-payload-for-fatal-log.test.ts`
 * for the snapshot + per-caller round-trip cases).
 */
const REDACT_ALLOWED_KEYS = new Set<string>([
  // Forensic context
  'severity',
  'requestId',
  'source',
  'scope',
  // Probe/attack signals
  'sourceIp',
  'attemptedRoute',
  'probedTenantId',
  'signedTenantId',
  'probedId',
  'probeSurface',
  'probedAt',
  // Signature failure details
  'signatureLastFour',
  'timestampSkewSeconds',
  'bodyLengthBytes',
  // Operation outcomes
  'errorName',
  'failureStage',
  'stage',
  'rowNumber',
  'rowsCleared',
  'durationMs',
  // CSV import row counters (forensic primitives)
  'rowsProcessed',
  'rowsAlreadyImported',
  'rowsStateChanged',
  'eventsCreated',
  'eventsUpdated',
  'errorRowCount',
  'timedOut',
  'sourceFormat',
  // CSV import override forensics (non-PII UUIDs + Date)
  'recordId',
  'currentEventId',
  'overriddenAt',
  // Identifiers (non-PII)
  'registrationId',
  'eventId',
  'matchType',
  // Actor classification (non-PII)
  'actorType',
  'actorUserId',
  'dispatchedByActorUserId',
  'dispatchedByActorRole',
  'actorRole',
  'attemptedAction',
  'blockedAt',
  // Cancellation forensics (already-hashed PII — safe to log)
  'attendeeEmailHash',
  // State signals
  'graceSecretUsed',
  'graceSecretAgeHours',
  'reason',
]);

/**
 * PII-redacted forensic projection of an audit payload for the
 * `emitStandalone` + `emitRolledBack` dual-write `pino.fatal` fallback
 * paths. Only forensically-useful fields are preserved — raw email,
 * names, company, phone never make it to the log line even if a future
 * audit event type carries them. This is defence-in-depth against
 * caller drift (current callers don't carry PII, but the contract is
 * shared infrastructure).
 */
function redactPayloadForFatalLog(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return { _shape: 'non-object' };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (REDACT_ALLOWED_KEYS.has(k)) {
      // Only primitives — drop nested objects which may contain PII.
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        v === null
      ) {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Re-exported for H4.1 snapshot test (43-event union allowlist parity). */
export { REDACT_ALLOWED_KEYS, redactPayloadForFatalLog };

async function insertAuditRow(
  executor: TenantTx | Database,
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
        // R7 CODE-FR-03 corrected — fire matching OTel counter AFTER
        // `insertAuditRow` resolves (not after tx commit). See H3
        // docstring above L51-66 — counter increment is NOT tx-bound;
        // partial-tx-rollback drift is documented and bounded to
        // `≤ 2 × currentIteration` phantom increments (each row can
        // emit BOTH partnership + cultural credit-back audits =>
        // 2 counters/row).
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
      // Separate-tx path — wraps the FR-037 rollback audit in its own
      // tx so a primary-tx failure doesn't propagate. Uses `runInTenant`
      // (the canonical tenant-scoped tx helper in `src/lib/db.ts`) which
      // applies `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`
      // and validates the slug shape at the trust boundary via
      // `asTenantContext`. Any malformed slug throws `InvalidTenantSlugError`,
      // caught by the outer try/catch below → falls through to the
      // pino.fatal + stderr last-ditch chain.
      try {
        const id = await runInTenant(
          asTenantContext(String(entry.tenantId)),
          async (tx) => insertAuditRow(tx, entry),
        );
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
              payload: redactPayloadForFatalLog(entry.payload),
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

    async findPriorErasureCompletion(
      tenantId: TenantId,
      registrationId: RegistrationId,
    ): Promise<Result<boolean, AuditEmitError>> {
      // Phase 10 T110 idempotency probe — see audit-port.ts contract.
      // Uses the caller's tx so the SELECT honours the same RLS scope as
      // the surrounding strict-tx unit. `payload->>'registrationId'` is
      // text comparison; both sides cast via `String(...)` upstream so
      // brand-stripping is harmless.
      try {
        const result = await executor.execute(sql`
          SELECT 1
          FROM audit_log
          WHERE tenant_id = ${tenantId}
            AND event_type = 'pii_erasure_completed'::audit_event_type
            AND payload->>'registrationId' = ${String(registrationId)}
          LIMIT 1
        `);
        const rows = result as unknown as ReadonlyArray<unknown>;
        return ok(rows.length > 0);
      } catch (e) {
        logFullError(
          {
            caller: 'findPriorErasureCompletion',
            tenantId,
            eventType: 'pii_erasure_completed',
          },
          e,
        );
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
      // `emitRolledBack` but accepts any F6 event type. Uses
      // `runInTenant` so the tx is properly tenant-scoped with role +
      // GUC; `asTenantContext` validates the slug shape at the boundary.
      try {
        const id = await runInTenant(
          asTenantContext(String(entry.tenantId)),
          async (tx) => insertAuditRow(tx, entry),
        );
        // R6 SUGG-R5-2 + PERF-R6-03 — fire the matching OTel counter
        // for any quota event routed through this standalone path
        // (e.g., a future F6.1 manual-recovery script). Currently the
        // only standalone caller is `webhook_signature_rejected` which
        // falls through to `default: break`, so this is forward-compat
        // hardening — no behavioural change today.
        emitMatchingQuotaMetric(entry);
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
              payload: redactPayloadForFatalLog(entry.payload),
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
