/**
 * `importCsv` use-case (F6 Application — Phase 7 / User Story 5).
 *
 * Orchestrates the CSV bulk-import path. Reuses the shared
 * `processAttendeeInTx` helper so the CSV pipeline produces
 * byte-equivalent rows to the Phase 3 webhook pipeline — FR-027 by
 * construction, not parallel implementation drift.
 *
 * Algorithm (post-batched-tx refactor 2026-05-15, H-7 docblock fix):
 *   1. Parse the CSV stream via `CsvImporter.parseStream` (streaming
 *      hand-rolled parser).
 *      - Header-level error  → return `{kind:'invalid_header', missingColumns}`.
 *      - Per-row parse error → buffer into `errorRows[]` (no DB work);
 *        `csv_import_row_failed` audit fires per parser-rejected row
 *        before the batch tx opens.
 *   2. Split successfully parsed rows into batches of `batchSize`
 *      (default 100, per tasks.md T094 spec "batched 100 rows per tx;
 *      per-row failure isolation"). Run `batchConcurrency` workers
 *      (default 3 — caps connection-pool pressure; each batch holds
 *      1 Drizzle connection for its full duration). Workers pull
 *      batches off a shared queue via atomic `nextBatchIdx++`.
 *   3. Per batch (one Drizzle outer tx per 100 rows):
 *      a. Open `runInTenantTx` once — SET LOCAL ROLE chamber_app +
 *         SET LOCAL app.current_tenant propagate through every
 *         savepoint within the tx.
 *      b. For each row, call `batchPorts.runRowInSavepoint(...)` →
 *         Drizzle nested-tx → Postgres SAVEPOINT for per-row
 *         isolation. On row-fn throw, the savepoint rolls back;
 *         outer tx + other rows in the batch are preserved.
 *      c. Per-row sequence inside the savepoint:
 *           - Idempotency receipt INSERT with `source='eventcreate_csv'`
 *             + `request_id=parsed.rowHash`. ON CONFLICT → return
 *             `duplicate` outcome (NO audit per round-2 R3).
 *           - Map `CsvRow` → `ProcessAttendeeInTxInput` + call shared
 *             helper → event upsert + match + registration insert +
 *             quota + refund + match-resolution audit.
 *      d. Aggregate counters: rowsProcessed / rowsAlreadyImported /
 *         eventsCreated / eventsUpdated / matchCounts / errorRows.
 *   4. **Time-budget semantics (H-6 clarification 2026-05-15)**:
 *      `timeBudgetMs` (default 55_000) gates "may a worker start the
 *      NEXT batch?" — it does NOT mid-flight cancel a running batch.
 *      Once a worker has started a batch, it runs to completion. So
 *      total wall-clock can exceed timeBudget by up to
 *      `max(batchDurationMs)` (~25-50s on cross-region Neon, ~3-5s
 *      on prod-region). At the SC-006 1k-row envelope this is fine;
 *      callers running larger imports should tighten timeBudget
 *      explicitly. On budget breach the use-case returns
 *      `{kind:'timeout'}` AFTER all in-flight batches drain;
 *      committed rows persist (idempotency makes re-upload safe).
 *   5. After all batches commit: emit `csv_import_completed` audit
 *      (one per import, standalone-tx) with the full summary payload.
 *      Audit-emit failure logs to stderr via
 *      `eventcreateMetrics.csvImportAuditEmitFailed` (C-2 fix) so
 *      operators alert on forensic gaps.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 * Tx + tenant boundary is owned by Infrastructure via the injected
 * `runInTenantTx` factory; the use-case never touches Drizzle directly.
 *
 * Spec authority:
 *   - FR-026, FR-027 (CSV + webhook equivalence), FR-028 (result
 *     summary), FR-029 (row idempotency), SC-006 (1k rows / <60s).
 *   - contracts/csv-import-api.md § Processing semantics.
 *   - research.md R8 (streaming parse + inline processing + no queue).
 *   - tasks.md T094 line 225: "batched 100 rows per tx; per-row
 *     failure isolation".
 */
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { asTenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { MatchType } from '../../domain/value-objects/match-type';
import {
  TxStageError,
  type FailureStage,
} from './_helpers/process-attendee-in-tx';
import type {
  CsvImporter,
  ParsedRow,
} from '../ports/csv-importer';
import type {
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../ports/audit-port';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { Result } from '@/lib/result';
import type { AuditEventId } from '@/modules/auth';
import {
  processAttendeeInTx,
  type ProcessAttendeeInTxPorts,
} from './_helpers/process-attendee-in-tx';

// ---------------------------------------------------------------------------
// Result + summary types
// ---------------------------------------------------------------------------

export interface ImportSummary {
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  readonly eventsCreated: number;
  readonly eventsUpdated: number;
  readonly matchCounts: Readonly<Record<MatchType, number>>;
  readonly errorRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly reason: string;
  }>;
  readonly durationMs: number;
}

export type ImportCsvOutcome =
  | { readonly kind: 'completed'; readonly summary: ImportSummary }
  | {
      readonly kind: 'invalid_header';
      readonly missingColumns: ReadonlyArray<string>;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unexpected_error'; readonly message: string };

export interface ImportCsvInput {
  readonly tenantId: string;
  readonly actorUserId: UserId;
  readonly bytes: Uint8Array;
  readonly columnMapping?: ReadonlyMap<string, string>;
  /**
   * Time budget in ms; default 55_000. **Soft guarantee**: gates "may
   * a worker start the NEXT batch?" — does NOT cancel a running batch
   * mid-flight. Total wall-clock can exceed `timeBudgetMs` by up to
   * `max(batchDurationMs)` (~3-5s prod-region, ~25-50s cross-region
   * dev). At the SC-006 1k-row envelope on prod-region the 5s safety
   * margin vs 60s SLO is sufficient; large-fixture callers should
   * tighten this value explicitly (see H-6 doc fix 2026-05-15).
   */
  readonly timeBudgetMs?: number;
  /**
   * Rows per outer transaction (batched-tx + SAVEPOINT-per-row
   * pattern). Default 100 — aligns with tasks.md T094 spec ("batched
   * 100 rows per tx; per-row failure isolation"). Lower values trade
   * connection-pool pressure for tx-overhead amortisation.
   */
  readonly batchSize?: number;
  /**
   * Concurrent batches. Default 3 — each batch holds 1 Drizzle
   * connection for its full duration; higher values strain the
   * postgres-js pool (default 10). Cross-tenant + cross-member
   * isolation is enforced by RLS + per-quota advisory locks
   * regardless of concurrency.
   */
  readonly batchConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Tx-scoped ports — superset of `ProcessAttendeeInTxPorts` with the
// CSV-specific `idempotencyStore` + the SAVEPOINT-per-row helper
// `runRowInSavepoint`. Mirrors the webhook `TxScopedPorts` shape +
// adds the savepoint method (webhook single-attendee path doesn't
// need savepoints).
// ---------------------------------------------------------------------------

export interface ImportCsvTxScopedPorts extends ProcessAttendeeInTxPorts {
  readonly idempotencyStore: IdempotencyStore;
  /**
   * Run `fn` inside a Drizzle nested-tx (Postgres SAVEPOINT) scoped
   * to this batch's outer tx. On throw, the savepoint rolls back but
   * the outer tx + other rows in the batch are preserved. The fn
   * receives a fresh set of tx-scoped ports bound to the savepoint.
   *
   * Implementation note: Drizzle's `tx.transaction(...)` creates a
   * SAVEPOINT when called inside an existing transaction (per Drizzle
   * docs § Transactions / nested). Per Postgres semantics, SET LOCAL
   * propagates through savepoints — the outer tx's
   * `app.current_tenant` GUC remains active inside the savepoint, so
   * RLS continues to enforce tenant isolation.
   */
  readonly runRowInSavepoint: <T>(
    fn: (spPorts: ImportCsvTxScopedPorts) => Promise<T>,
  ) => Promise<T>;
}

export interface ImportCsvDeps {
  readonly csvImporter: CsvImporter;
  readonly runInTenantTx: <T>(
    tenantId: string,
    fn: (ports: ImportCsvTxScopedPorts) => Promise<T>,
  ) => Promise<T>;
  /**
   * Standalone-tx audit emit for `csv_import_completed` (per-import)
   * and `csv_import_row_failed` (per failed row). Same shape as the
   * webhook use-case's `emitStandalone` — runs in its own `db.transaction`
   * so audit emit semantics are independent of the batch tx.
   */
  readonly emitStandalone: <T extends F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ) => Promise<Result<AuditEventId, AuditEmitError>>;
}

// ---------------------------------------------------------------------------
// Per-row outcome (use-case-internal — never escapes)
// ---------------------------------------------------------------------------

type RowOutcome =
  | { readonly kind: 'parse_failed'; readonly rowNumber: number; readonly reason: string }
  | { readonly kind: 'duplicate'; readonly rowNumber: number }
  | {
      readonly kind: 'inserted';
      readonly rowNumber: number;
      readonly matchType: MatchType;
      readonly eventCreated: boolean;
    }
  | {
      readonly kind: 'row_failed';
      readonly rowNumber: number;
      readonly reason: string;
      /**
       * H-3 fix (2026-05-15): preserve `TxStageError.stage` from the
       * shared `processAttendeeInTx` helper so dashboards can alert
       * on `audit_emit` failures (security-critical) separately from
       * routine `event_upsert` / `registration_insert` / `quota_decrement`
       * row-level validation failures. `'unknown'` reserved for non-
       * TxStageError throws (e.g., plain Error propagated past the
       * helper's Result-check guards).
       */
      readonly failureStage: FailureStage;
    };

function zeroMatchCounts(): Record<MatchType, number> {
  return {
    member_contact: 0,
    member_domain: 0,
    member_fuzzy: 0,
    non_member: 0,
    unmatched: 0,
  };
}

/**
 * Resolve the attendee_external_id for a CSV row.
 *
 * Priority order (E1 verification fix):
 *   1. CSV-supplied `attendee_external_id` column (verbatim — preserves
 *      webhook-equivalent IDs when the CSV was exported from the same
 *      EventCreate dataset that the webhook would have delivered).
 *   2. Fallback: synthetic `csv_${rowHash.slice(0,32)}` — derived from
 *      `(event_external_id, attendee_email_lower, registered_at)` per
 *      contracts/csv-import-api.md § "Optional columns". Prefix makes
 *      synthetic IDs visually distinguishable from EventCreate-issued
 *      ones in admin DB inspection.
 */
function resolveAttendeeExternalId(
  rowSuppliedId: string | undefined,
  rowHash: string,
): string {
  if (rowSuppliedId !== undefined && rowSuppliedId.length > 0) {
    return rowSuppliedId;
  }
  return `csv_${rowHash.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Per-row processor — runs INSIDE a SAVEPOINT bound to the batch's
// outer tx. On throw, the savepoint rolls back; the outer tx + other
// rows in the batch are preserved (per-row failure isolation per
// tasks.md T094 spec).
// ---------------------------------------------------------------------------

async function processOneRowInSavepoint(
  parsed: ParsedRow,
  input: ImportCsvInput,
  batchPorts: ImportCsvTxScopedPorts,
  deps: ImportCsvDeps,
): Promise<RowOutcome> {
  if (!parsed.ok) {
    // Parser-rejected row — emit `csv_import_row_failed` audit + bubble
    // up. No savepoint needed (no DB work for parser-failed rows).
    await safeEmitRowFailed(deps, input, parsed.rowNumber, parsed.reason, parsed.rawExcerpt);
    return {
      kind: 'parse_failed',
      rowNumber: parsed.rowNumber,
      reason: parsed.reason,
    };
  }

  try {
    return await batchPorts.runRowInSavepoint(async (ports) => {
      // (a) Idempotency receipt — silent skip on duplicate per round-2
      //     R3 (CSV duplicates from admin re-upload; not webhook replay).
      const receipt = await ports.idempotencyStore.tryInsert({
        tenantId: asTenantId(input.tenantId),
        source: 'eventcreate_csv',
        requestId: parsed.rowHash,
      });
      if (!receipt.ok) {
        throw new Error(`idempotency receipt insert failed: ${receipt.error.message}`);
      }
      if (!receipt.value.wasFresh) {
        return { kind: 'duplicate' as const, rowNumber: parsed.rowNumber };
      }

      // (b) + (c) Map CsvRow → ProcessAttendeeInTxInput + run shared
      //           helper. The helper handles event upsert + match +
      //           registration insert + quota + refund + match-resolution
      //           audit, all within the SAVEPOINT scope.
      const csvRow = parsed.row;
      const eventStart = new Date(csvRow.event_start);
      const registeredAt = csvRow.registered_at
        ? new Date(csvRow.registered_at)
        : eventStart;
      const result = await processAttendeeInTx(
        {
          tenantId: asTenantId(input.tenantId),
          actorContext: {
            actorType: 'csv_import',
            actorUserId: input.actorUserId,
          },
          event: {
            externalId: csvRow.event_external_id,
            name: csvRow.event_name,
            description: null,
            startDate: eventStart,
            endDate: null,
            location: null,
            category: csvRow.event_category ?? null,
            eventcreateUrl: null,
            metadata: {},
          },
          attendee: {
            externalId: resolveAttendeeExternalId(
              csvRow.attendee_external_id,
              parsed.rowHash,
            ),
            email: csvRow.attendee_email,
            fullName: csvRow.attendee_name,
            companyName: csvRow.attendee_company ?? null,
            ticketType: csvRow.ticket_type ?? null,
            ticketPricePaid: csvRow.ticket_price_thb ?? null,
            paymentStatus: csvRow.payment_status,
            registeredAt,
            metadata: {},
          },
        },
        ports,
      );

      return {
        kind: 'inserted' as const,
        rowNumber: parsed.rowNumber,
        matchType: result.matchType,
        eventCreated: result.eventCreated,
      };
    });
  } catch (e) {
    // Savepoint rolled back. Outer tx + other rows preserved.
    // H-3 fix (2026-05-15): preserve the helper's TxStageError.stage
    // taxonomy so callers + audit dashboards can distinguish
    // audit-emit failures (security-critical) from validation /
    // event-upsert / quota / registration-insert paths.
    const reason = e instanceof Error ? e.message : String(e);
    const failureStage: FailureStage =
      e instanceof TxStageError ? e.stage : 'unknown';
    await safeEmitRowFailed(deps, input, parsed.rowNumber, reason, '');
    return {
      kind: 'row_failed',
      rowNumber: parsed.rowNumber,
      reason,
      failureStage,
    };
  }
}

// ---------------------------------------------------------------------------
// Batch processor — 1 outer tx, N rows inside via SAVEPOINTs
// ---------------------------------------------------------------------------

async function processBatch(
  batch: ReadonlyArray<ParsedRow>,
  input: ImportCsvInput,
  deps: ImportCsvDeps,
): Promise<ReadonlyArray<RowOutcome>> {
  // Pre-emit failures for parser-rejected rows BEFORE opening the tx
  // (these don't need DB work). This also reduces tx wall-clock by
  // avoiding the savepoint overhead for parser-failed rows.
  const outcomes: RowOutcome[] = new Array(batch.length);
  const dbRows: Array<{ index: number; row: ParsedRow }> = [];
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i] as ParsedRow;
    if (!row.ok) {
      await safeEmitRowFailed(deps, input, row.rowNumber, row.reason, row.rawExcerpt);
      outcomes[i] = {
        kind: 'parse_failed',
        rowNumber: row.rowNumber,
        reason: row.reason,
      };
    } else {
      dbRows.push({ index: i, row });
    }
  }

  if (dbRows.length === 0) {
    return outcomes;
  }

  // Open ONE outer tx for the whole batch's DB work. Inside the tx,
  // each row runs in its own SAVEPOINT (via `runRowInSavepoint`) so
  // per-row failures don't poison the batch.
  try {
    await deps.runInTenantTx(input.tenantId, async (batchPorts) => {
      for (const { index, row } of dbRows) {
        outcomes[index] = await processOneRowInSavepoint(
          row,
          input,
          batchPorts,
          deps,
        );
      }
    });
  } catch (e) {
    // H-1 fix (2026-05-15): batch-level catastrophic failure
    // (e.g. tx-open failed, RLS denial — Constitution Principle I bug
    // signal — connection-pool exhaustion, deadlock). Previously
    // collapsed silently into generic `row_failed` outcomes with NO
    // log + NO per-row audit emit. Now logs once at batch level + fans
    // out `csv_import_row_failed` audits so the forensic trail captures
    // each row's identity even when the batch tx aborted.
    const reason = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        event: 'f6_csv_batch_tx_aborted',
        tenantId: input.tenantId,
        batchRowCount: dbRows.length,
        firstRowNumber: dbRows[0]?.row.rowNumber,
        lastRowNumber: dbRows[dbRows.length - 1]?.row.rowNumber,
        err: reason,
      },
      '[F6] CSV batch tx aborted — all rows in batch failed; investigate RLS / pool / deadlock signals',
    );
    for (const { index, row } of dbRows) {
      if (outcomes[index] === undefined) {
        // Best-effort per-row audit fan-out so forensic trail is
        // preserved even though the batch tx never committed any
        // rows. safeEmitRowFailed itself handles audit-emit failures
        // via C-1 logging.
        await safeEmitRowFailed(
          deps,
          input,
          row.rowNumber,
          `batch tx aborted: ${reason}`,
          '',
        );
        outcomes[index] = {
          kind: 'row_failed',
          rowNumber: row.rowNumber,
          reason: `batch tx aborted: ${reason}`,
          failureStage: 'unknown',
        };
      }
    }
  }

  return outcomes;
}

/**
 * Wrap `csv_import_row_failed` emit in a try/catch — an audit failure
 * on a row-failure path should not cascade into a use-case-level
 * exception. **Phase 7 review C-1 fix (2026-05-15)**: previous "swallow
 * + best-effort" pattern lost the forensic trail when the audit emitter
 * itself failed (composition-root bugs in `makeLoudDummyExecutorPort`
 * + audit-port DB outages + enum drift all swallowed silently). Now
 * logs via `logger.error` + emits the dedicated `csvImportAuditEmitFailed`
 * counter so SREs can alert on `rate > 0`. The row's outcome is still
 * captured by `errorRowCount` on `csv_import_completed`, but the
 * detailed `rowNumber + reason + rawRowExcerpt` forensic trio is now
 * preserved in stderr when the DB write fails.
 */
async function safeEmitRowFailed(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  rowNumber: number,
  reason: string,
  rawExcerpt: string,
): Promise<void> {
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_row_failed',
      tenantId: asTenantId(input.tenantId),
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: `CSV row ${rowNumber} failed: ${reason.slice(0, 200)}`,
      payload: {
        severity: 'warn',
        actorUserId: input.actorUserId,
        rowNumber,
        reason: reason.slice(0, 500),
        rawRowExcerpt: rawExcerpt.slice(0, 200),
      },
    });
    if (!result.ok) {
      eventcreateMetrics.csvImportAuditEmitFailed(
        input.tenantId,
        'csv_import_row_failed',
      );
      logger.error(
        {
          event: 'f6_csv_row_failed_audit_emit_failed',
          tenantId: input.tenantId,
          rowNumber,
          reason: reason.slice(0, 500),
          auditErrKind: result.error.kind,
        },
        '[F6] csv_import_row_failed audit emit failed — forensic trail loss; row outcome still tracked in summary counter',
      );
    }
  } catch (e) {
    // Catastrophic emit-throw (composition-root bug, transport down,
    // OOM mid-serialise). Surface to stderr so the forensic gap is
    // visible even though the DB write was never attempted.
    eventcreateMetrics.csvImportAuditEmitFailed(
      input.tenantId,
      'csv_import_row_failed',
    );
    logger.error(
      {
        event: 'f6_csv_row_failed_audit_emit_threw',
        tenantId: input.tenantId,
        rowNumber,
        reason: reason.slice(0, 500),
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] csv_import_row_failed audit emitter threw — forensic trail loss',
    );
  }
}

// ---------------------------------------------------------------------------
// Main use-case
// ---------------------------------------------------------------------------

export async function importCsv(
  input: ImportCsvInput,
  deps: ImportCsvDeps,
): Promise<ImportCsvOutcome> {
  const startedAtMs = Date.now();
  const timeBudgetMs = input.timeBudgetMs ?? 55_000;
  const batchSize = Math.max(1, input.batchSize ?? 100);
  const batchConcurrency = Math.max(1, input.batchConcurrency ?? 3);

  // Phase 1: parse the CSV stream.
  let parsed: Awaited<ReturnType<CsvImporter['parseStream']>>;
  try {
    parsed = await deps.csvImporter.parseStream({
      bytes: input.bytes,
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
    });
  } catch (e) {
    return {
      kind: 'unexpected_error',
      message: e instanceof Error ? e.message : 'parser threw',
    };
  }
  if (!parsed.ok) {
    if (parsed.error.kind === 'invalid_header') {
      return {
        kind: 'invalid_header',
        missingColumns: parsed.error.missingColumns,
      };
    }
    // file_too_large / invalid_utf8 — escalate as 500 to the route
    return {
      kind: 'unexpected_error',
      message: `parser error: ${parsed.error.kind}`,
    };
  }

  // Phase 2: collect rows from the async stream into an array (the
  // SC-006 design envelope is 1,000 rows; per the streaming-parser
  // bench T138 at 5,000 rows peak heap stays <500 MiB so a single
  // collect is safe at this scale).
  const rows: ParsedRow[] = [];
  for await (const r of parsed.value) {
    rows.push(r);
  }

  // Phase 3: split into batches of `batchSize`, process `batchConcurrency`
  // batches in parallel via a sliding-window scheduler. Each batch
  // opens 1 outer tx + iterates rows via SAVEPOINTs (tasks.md T094
  // "batched 100 rows per tx; per-row failure isolation").
  const summary = {
    rowsProcessed: 0,
    rowsAlreadyImported: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    matchCounts: zeroMatchCounts(),
    errorRows: [] as Array<{ rowNumber: number; reason: string }>,
  };

  const batches: Array<ReadonlyArray<ParsedRow>> = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize));
  }

  let nextBatchIdx = 0;
  let timeBudgetExceeded = false;

  async function worker(): Promise<void> {
    while (true) {
      if (timeBudgetExceeded) return;
      if (Date.now() - startedAtMs > timeBudgetMs) {
        timeBudgetExceeded = true;
        return;
      }
      const idx = nextBatchIdx++;
      if (idx >= batches.length) return;
      const batch = batches[idx] as ReadonlyArray<ParsedRow>;
      const outcomes = await processBatch(batch, input, deps);
      for (const outcome of outcomes) {
        switch (outcome.kind) {
          case 'parse_failed':
            summary.errorRows.push({
              rowNumber: outcome.rowNumber,
              reason: outcome.reason,
            });
            break;
          case 'duplicate':
            summary.rowsAlreadyImported += 1;
            break;
          case 'inserted':
            summary.rowsProcessed += 1;
            summary.matchCounts[outcome.matchType] += 1;
            if (outcome.eventCreated) {
              summary.eventsCreated += 1;
            } else {
              summary.eventsUpdated += 1;
            }
            break;
          case 'row_failed':
            summary.errorRows.push({
              rowNumber: outcome.rowNumber,
              reason: outcome.reason,
            });
            break;
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(batchConcurrency, batches.length) },
    () => worker(),
  );
  await Promise.all(workers);

  if (timeBudgetExceeded) {
    // Rows already committed in completed batches persist; re-upload
    // is idempotent (rowHash matches → silent skip).
    return { kind: 'timeout' };
  }

  const durationMs = Date.now() - startedAtMs;

  // Phase 4: emit per-import `csv_import_completed` audit.
  // **Phase 7 review C-2 fix (2026-05-15)**: previous swallow lost the
  // entire-import forensic record (matchCounts + eventsCreated +
  // errorRowCount + durationMs all canonical here, no other recovery
  // surface). Now logs + counters so SREs alert on forensic gaps even
  // when the route still returns 200 + the dashboard counter increments.
  let completedAuditOk = true;
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_completed',
      tenantId: asTenantId(input.tenantId),
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: `CSV import completed: ${summary.rowsProcessed} processed, ${summary.rowsAlreadyImported} idempotency-skipped, ${summary.errorRows.length} errors in ${durationMs}ms`,
      payload: {
        severity: 'info',
        actorUserId: input.actorUserId,
        rowsProcessed: summary.rowsProcessed,
        rowsAlreadyImported: summary.rowsAlreadyImported,
        eventsCreated: summary.eventsCreated,
        eventsUpdated: summary.eventsUpdated,
        matchCounts: summary.matchCounts,
        errorRowCount: summary.errorRows.length,
        durationMs,
      },
    });
    if (!result.ok) {
      completedAuditOk = false;
      eventcreateMetrics.csvImportAuditEmitFailed(
        input.tenantId,
        'csv_import_completed',
      );
      logger.error(
        {
          event: 'f6_csv_import_completed_audit_emit_failed',
          tenantId: input.tenantId,
          rowsProcessed: summary.rowsProcessed,
          rowsAlreadyImported: summary.rowsAlreadyImported,
          errorRowCount: summary.errorRows.length,
          durationMs,
          auditErrKind: result.error.kind,
        },
        '[F6] csv_import_completed audit emit failed — entire-import forensic record lost; DB side effects committed but no audit row exists',
      );
    }
  } catch (e) {
    completedAuditOk = false;
    eventcreateMetrics.csvImportAuditEmitFailed(
      input.tenantId,
      'csv_import_completed',
    );
    logger.error(
      {
        event: 'f6_csv_import_completed_audit_emit_threw',
        tenantId: input.tenantId,
        rowsProcessed: summary.rowsProcessed,
        rowsAlreadyImported: summary.rowsAlreadyImported,
        errorRowCount: summary.errorRows.length,
        durationMs,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] csv_import_completed audit emitter threw — entire-import forensic record lost',
    );
  }
  void completedAuditOk; // Reserved for future caller-visible signal; today the route returns 200 regardless per the "DB committed" invariant.

  return {
    kind: 'completed',
    summary: { ...summary, durationMs },
  };
}
