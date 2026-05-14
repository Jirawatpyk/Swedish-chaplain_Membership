/**
 * T094 — `importCsv` use-case (F6 Application).
 *
 * Orchestrates the CSV bulk-import path (Phase 7 / User Story 5).
 * Reuses the Phase 7 pre-work `processAttendeeInTx` helper so the CSV
 * pipeline produces byte-equivalent rows to the Phase 3 webhook
 * pipeline — FR-027 by construction.
 *
 * Algorithm:
 *   1. Parse the CSV stream via `CsvImporter.parseStream` (T093 adapter).
 *      - Header-level error  → return `{kind:'invalid_header', missingColumns}`.
 *      - Per-row parse error → collect as `errorRows[]` + emit
 *        `csv_import_row_failed` audit; continue.
 *   2. For each successfully parsed row, process in parallel batches of
 *      `BATCH_PARALLELISM` (default 10). Each row runs in its OWN
 *      `runInTenantTx` transaction → row-level failure isolation
 *      (one bad row never affects 99 good neighbours). Concurrent
 *      rows targeting the same (tenant, member, event) tuple are
 *      naturally serialised by the per-quota advisory lock acquired
 *      inside `processAttendeeInTx` (research.md R5 + Phase 6 T085).
 *   3. Per-row sequence (inside the tx):
 *      a. Idempotency receipt INSERT with `source='eventcreate_csv'`
 *         + `request_id=parsed.rowHash`. ON CONFLICT → silent-skip
 *         (round-2 R3: distinguish `rowsAlreadyImported` from
 *         `rowsProcessed` — NO duplicate audit).
 *      b. Map `CsvRow` → `ProcessAttendeeInTxInput`.
 *      c. Call shared helper → ingest event + match attendee +
 *         registration + quota + refund + match-resolution audit.
 *      d. Aggregate counters: rowsProcessed / rowsAlreadyImported /
 *         eventsCreated / eventsUpdated / matchCounts.
 *   4. Time-budget guard between batches: if wall-clock > timeBudget
 *      → short-circuit + return `{kind:'timeout'}`. Already-processed
 *      rows persist (their txs committed independently); admin
 *      re-uploads the same CSV → idempotency skips the processed
 *      rows.
 *   5. After all batches: emit `csv_import_completed` audit (one per
 *      import, standalone-tx) with the full summary payload.
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
 */
import { asTenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { MatchType } from '../../domain/value-objects/match-type';
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
   * Time budget in ms; default 55_000 (5s safety margin vs SC-006
   * 60s SLO). When wall-clock exceeds this between batches, the
   * use-case short-circuits + returns `kind:'timeout'`.
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
    const reason = e instanceof Error ? e.message : String(e);
    await safeEmitRowFailed(deps, input, parsed.rowNumber, reason, '');
    return {
      kind: 'row_failed',
      rowNumber: parsed.rowNumber,
      reason,
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
    // Batch-level catastrophic failure (e.g. tx-open failed). Mark
    // all DB rows as row_failed; parser-failed rows already settled.
    const reason = e instanceof Error ? e.message : String(e);
    for (const { index, row } of dbRows) {
      if (outcomes[index] === undefined) {
        outcomes[index] = {
          kind: 'row_failed',
          rowNumber: row.rowNumber,
          reason: `batch tx aborted: ${reason}`,
        };
      }
    }
  }

  return outcomes;
}

/**
 * Wrap `csv_import_row_failed` emit in a try/catch — an audit failure
 * on a row-failure path should not cascade into a use-case-level
 * exception (the row failure is already being reported via the
 * outcome object). Mirrors the F1 + F6 "observability not
 * availability" pattern.
 */
async function safeEmitRowFailed(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  rowNumber: number,
  reason: string,
  rawExcerpt: string,
): Promise<void> {
  try {
    await deps.emitStandalone({
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
  } catch {
    // Swallow — row-failure audit is best-effort. The summary
    // counter `errorRowCount` on `csv_import_completed` still
    // captures the failure count.
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

  // Phase 4: emit per-import `csv_import_completed` audit (best-
  // effort; never fail the whole import on audit failure).
  try {
    await deps.emitStandalone({
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
  } catch {
    // Swallow — summary still surfaces to the route via the result.
  }

  return {
    kind: 'completed',
    summary: { ...summary, durationMs },
  };
}
