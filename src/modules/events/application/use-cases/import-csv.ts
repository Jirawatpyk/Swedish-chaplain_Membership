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
 *             `duplicate` outcome (NO audit per csv-import-api contracts R3).
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
 *      Audit-emit failure is observable via two channels — `logger.error`
 *      writes a stderr line (Vercel Fluid Compute captures it) AND
 *      `eventcreateMetrics.csvImportAuditEmitFailed` increments an
 *      OTel counter so SREs alert on `rate > 0`. The route returns 200
 *      regardless ("DB committed" invariant — rows already persisted).
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
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { asLockKey } from '../ports/advisory-lock-acquirer';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { EventId } from '../../domain/branded-types';
import {
  asCsvImportRecordId,
  type CsvImportRecordId,
} from '../../domain/csv-import-record-id';
import {
  computeAttendeeFingerprintFromEmails,
  type CsvAdapterMode,
} from '../../domain/eventcreate-csv-format';
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
import type {
  CsvImportRecordsRepository,
  PriorImportMatch,
} from '../ports/csv-import-records-repo';
import type { ErrorCsvStore } from '../ports/error-csv-store';
import type { Result } from '@/lib/result';
import type { AuditEventId } from '@/modules/auth';
import {
  processAttendeeInTx,
  type ProcessAttendeeInTxPorts,
} from './_helpers/process-attendee-in-tx';

// ---------------------------------------------------------------------------
// Result + summary types
// ---------------------------------------------------------------------------

export interface ImportSummaryErrorRow {
  readonly rowNumber: number;
  readonly reason: string;
  /** Present only when the row failed inside a savepoint via TxStageError. */
  readonly failureStage?: FailureStage;
}

export interface ImportSummary {
  /** F6.1 — total body rows the parser examined (Skipped + Processed + Failed + Already-imported). */
  readonly rowsTotal: number;
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  /** F6.1 — rows the parser rejected via the FR-007 Status filter (EventCreate format). */
  readonly rowsSkipped: number;
  /** F6.1 — explicit count = `errorRows.length` minus skipped (parser failures + savepoint failures). */
  readonly rowsFailed: number;
  /**
   * F6.1 Phase 4 US2 (T031) — count of re-uploaded rows whose
   * `payment_status` (Notes-inferred) differed from the persisted
   * value AND was successfully updated. Excludes refunded transitions
   * (those flow through `markRefunded` + the FR-018 quota credit-back
   * branch — counted separately by the existing `quota_credit_back_refund`
   * audit). Surfaced on the `csv_import_completed` audit payload so
   * post-launch the operator can review state-change frequency.
   */
  readonly rowsStateChanged: number;
  readonly eventsCreated: number;
  readonly eventsUpdated: number;
  readonly matchCounts: Readonly<Record<MatchType, number>>;
  readonly errorRows: ReadonlyArray<ImportSummaryErrorRow>;
  readonly durationMs: number;
}

export type ImportCsvOutcome =
  | {
      readonly kind: 'completed';
      /** F6.1 — `csv_import_records.record_id` for history page deep-link + signed-URL download. */
      readonly recordId: CsvImportRecordId;
      /** F6.1 — adapter mode detected at parse time (FR-001 / R2). */
      readonly sourceFormat: CsvAdapterMode;
      /** F6.1 — true iff `rowsFailed > 0` AND blob upload succeeded. */
      readonly errorCsvAvailable: boolean;
      readonly summary: ImportSummary;
      /**
       * F6.1 (Round 2 — silent-failure-hunter I-4): `true` when the
       * `csv_import_records` row was successfully persisted (placeholder
       * INSERT or CR-5 recovery INSERT). `false` when BOTH the
       * placeholder and recovery INSERT failed — the rows committed
       * are still safe, but admins quoting `recordId` to support will
       * not find a matching history row. The UI surface SHOULD degrade
       * the recordId chip / hide the "view history" link when this is
       * `false`.
       */
      readonly historyPersisted: boolean;
    }
  | {
      readonly kind: 'invalid_header';
      readonly missingColumns: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'timeout';
      /** F6.1 — partial-import record still committed; admins can re-upload idempotently. */
      readonly recordId: CsvImportRecordId;
      readonly sourceFormat: CsvAdapterMode;
      /**
       * TYPE-D4 (Round 1 — type-design-analyzer): carry partial summary
       * + errorCsvAvailable on the timeout path so admins are not blind
       * to which rows committed. The DB-side `csv_import_records` row
       * IS updated with `outcome='timeout'` + partial counts; this
       * field exposes the same data to the route handler before US5
       * history page ships.
       */
      readonly summary: ImportSummary;
      readonly errorCsvAvailable: boolean;
      /** See `completed.historyPersisted`. Same semantics. */
      readonly historyPersisted: boolean;
    }
  | {
      /**
       * F6.1 (FR-019b) — the safety net detected an import within the
       * last 30 days targeting a DIFFERENT event with the same attendee
       * fingerprint. ZERO side effects (no csv_import_records row, no
       * audit, no rows written). Admin re-submits with
       * `forceProceed: true` to bypass.
       */
      readonly kind: 'event_mismatch_warning';
      readonly priorImports: ReadonlyArray<PriorImportMatch>;
    }
  | { readonly kind: 'unexpected_error'; readonly message: string };

export interface SelectedEventForImport {
  readonly eventId: EventId;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

export interface ImportCsvInput {
  /**
   * Branded at the use-case boundary; route handler brands via
   * composition adapter (`runImportCsv` in events-csv-import-deps.ts).
   */
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  readonly bytes: Uint8Array;
  readonly columnMapping?: ReadonlyMap<string, string>;
  /**
   * F6.1 (Feature 013 · T022) — Admin-selected F6 event from the
   * upload-page dropdown. The composition layer (route → deps wrapper)
   * fetches the event row from `EventsRepository.findById` AFTER the
   * timing-safe ownership check + brand wraps the eventId. This payload
   * is merged into every row before `processAttendeeInTx`, overriding
   * any `event_*` columns in the CSV. The dropdown selection is
   * authoritative — generic-CSV `event_*` columns are ignored at the
   * importer-iteration layer.
   */
  readonly selectedEvent: SelectedEventForImport;
  /**
   * F6.1 (FR-019b/c) — admin bypass of the event-mismatch safety net.
   * When `true` AND the safety net would have triggered, emit
   * `csv_import_event_mismatch_overridden` audit (WARN severity) BEFORE
   * proceeding with the normal commit flow. When `false`/absent + the
   * safety net triggers, the use-case returns `event_mismatch_warning`
   * with ZERO side effects.
   */
  readonly forceProceed?: boolean;
  /**
   * F6.1 — original CSV filename from the multipart upload. Persisted
   * in `csv_import_records.original_filename` for the US5 history-page
   * display (audit trail). Truncated to 512 chars defensively.
   */
  readonly originalFilename?: string;
  /**
   * F6.1 — opaque CSV-import record id. If omitted, the use-case
   * generates a fresh UUID via `randomUUID()`. Exposed for test seams
   * (deterministic recordId in fixture-based integration tests).
   */
  readonly recordId?: CsvImportRecordId;
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
  /**
   * T053 (F6.1 Phase 6) — when `false`, skip EventCreate adapter
   * detection + force the generic-CSV path. Composition layer reads
   * `env.features.f6EventCreateAdapter` and passes through. Default
   * `true` (omitted ⇒ normal detection runs).
   */
  readonly adapterEnabled?: boolean;
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
  /**
   * F6.1 (Feature 013 · T022) — Open a fresh tenant-scoped tx with
   * `app.current_tenant` GUC set, and invoke `fn` with a Drizzle-backed
   * `CsvImportRecordsRepository`. Each call opens its OWN tx so a failed
   * batch tx (later in the use-case) doesn't roll back the placeholder
   * import-record. The composition layer (deps factory) wires this to
   * `runInTenant` + `makeDrizzleCsvImportRecordsRepository`.
   */
  readonly withImportRecordsTx: <T>(
    tenantId: string,
    fn: (repo: CsvImportRecordsRepository) => Promise<T>,
  ) => Promise<T>;
  /**
   * F6.1 (Feature 013 · T021) — Tenant-scoped error-CSV blob storage.
   * The use-case calls `put` when `rowsFailed > 0` so US5's download
   * route can later issue a signed URL over the persisted bytes.
   */
  readonly errorCsvStore: ErrorCsvStore;
}

// ---------------------------------------------------------------------------
// F6.1 Phase 4 US2 (T033) — Cancellation pre-existence marker
// ---------------------------------------------------------------------------
//
// Thrown inside a SAVEPOINT to roll back a first-time-Cancellation row
// (no prior registration exists — the FR-018 refund branch had nothing
// to flip, and the row that `insertOnConflictDoNothing` just created
// is a useless refunded ghost). The outer catch maps to a `skipped`
// row outcome (counted in `rowsSkipped`, NOT `rowsFailed`), audit-quiet
// — first-time cancellation is expected behaviour, not a failure.

// CR-10 (R1 — silent-failure): Symbol brand prevents collision with
// any future Error subclass also named `CancellationSkipMarker`
// (3rd-party lib, cross-realm vm contexts, etc.). The brand is
// constant-identity so `instanceof` AND brand-equality both pass.
const CANCELLATION_SKIP_BRAND = Symbol('f6.csv-skip.cancellation');

class CancellationSkipMarker extends Error {
  static readonly brand = CANCELLATION_SKIP_BRAND;
  readonly _csvSkipBrand = CANCELLATION_SKIP_BRAND;
  constructor(
    public readonly rowNumber: number,
    public readonly email: string,
  ) {
    super(`Cancellation skip marker (rowNumber=${rowNumber})`);
  }
}

function isCancellationSkip(e: unknown): e is CancellationSkipMarker {
  return (
    e instanceof CancellationSkipMarker &&
    (e as CancellationSkipMarker)._csvSkipBrand === CANCELLATION_SKIP_BRAND
  );
}

// ---------------------------------------------------------------------------
// Per-row outcome (use-case-internal — never escapes)
// ---------------------------------------------------------------------------

type RowOutcome =
  | { readonly kind: 'parse_failed'; readonly rowNumber: number; readonly reason: string }
  | {
      /**
       * F6.1 (FR-007) — parser rejected the row via the EventCreate
       * Status filter (`Status !== 'Attending'`). Counted in
       * `rowsSkipped` (NOT `rowsFailed`); not written to the error-CSV
       * blob and no `csv_import_row_failed` audit emitted (route maps
       * these to a separate `errorRows` entry with a "Skipped:" prefix).
       */
      readonly kind: 'skipped';
      readonly rowNumber: number;
      readonly reason: string;
    }
  | { readonly kind: 'duplicate'; readonly rowNumber: number }
  | {
      /**
       * F6.1 Phase 4 US2 (T031) — receipt-duplicate row whose
       * `payment_status` (Notes-inferred) differed from the persisted
       * value AND was successfully UPDATEd to the new value. Counted
       * in `rowsStateChanged` (NOT `rowsAlreadyImported`); surfaced on
       * the `csv_import_completed` audit payload.
       */
      readonly kind: 'state_changed';
      readonly rowNumber: number;
      readonly previousPaymentStatus: string;
      readonly newPaymentStatus: string;
    }
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
       * `TxStageError.stage` from the shared `processAttendeeInTx`
       * helper so dashboards can alert on `audit_emit` failures
       * (security-critical) separately from routine validation /
       * event-upsert / quota / registration-insert paths. `'unknown'`
       * for non-TxStageError throws.
       */
      readonly failureStage: FailureStage;
    };

/**
 * F6.1 (Feature 013 · T022) — classify a parser-rejected row.
 * `iterateEventCreateRows` yields `Skipped: Status=…` reasons for the
 * FR-007 Status filter; everything else is a real parse failure.
 */
function isSkippedParserRow(reason: string): boolean {
  return reason.startsWith('Skipped:');
}

/**
 * F6.1 Phase 4 US2 (T031) — receipt-duplicate state-change detection.
 *
 * On re-upload, the idempotency receipt rowHash matches the first
 * upload's hash (event_external_id, email, registered_at) regardless
 * of payment_status. When admins fix the Notes column between runs
 * (e.g., `verifying payment` → `Paid`), the receipt dedup catches the
 * second arrival as duplicate; this helper unblocks the case by
 * looking up the persisted row, comparing payment_status, and
 * applying an UPDATE if they differ.
 *
 * Returns:
 *   - `null` when no state change is needed (truly idempotent
 *     duplicate) — caller returns `{kind:'duplicate'}`.
 *   - `{kind:'state_changed', ...}` when an UPDATE was applied.
 *
 * Out-of-scope:
 *   - Refund transitions (paid → refunded): would route through
 *     `markRefunded` + FR-018 credit-back, but the receipt is
 *     bypassed entirely for Cancellation rows (`intendedStateChange`
 *     flag at the parser level), so refunds never reach this branch.
 *     Company / ticket_type changes: Q2 "no locked-field semantics"
 *     cut — out of scope.
 *
 * Failure handling: any error (DB / lookup miss / pseudonymised row)
 * falls back to `null` (admin gets `rowsAlreadyImported++`) — the
 * state-change is a best-effort enhancement, not a correctness
 * invariant. The persisted row stays at its old value; next re-upload
 * tries again.
 */
async function maybeApplyStateChange(
  parsed: ParsedOkRow,
  input: ImportCsvInput,
  ports: ImportCsvTxScopedPorts,
): Promise<RowOutcome | null> {
  // Skip refund transitions — handled by the intendedStateChange
  // Cancellation path which bypasses the receipt entirely.
  if (parsed.row.payment_status === 'refunded') return null;

  const repo = ports.registrationsRepo;

  try {
    const existing = await repo.findByEventAndEmail(
      input.tenantId,
      input.selectedEvent.eventId,
      parsed.row.attendee_email,
    );
    if (!existing.ok) {
      // CR-8 (R1 — silent-failure): lookup err is a real signal
      // (RLS denial, serialisation failure, pool exhaustion). Log +
      // metric so SRE sees the rate; row falls back to duplicate so
      // admin sees `rowsAlreadyImported` (next re-upload retries).
      logger.warn(
        {
          event: 'f6_csv_state_change_lookup_err',
          tenantId: input.tenantId,
          rowNumber: parsed.rowNumber,
          err: existing.error.kind,
        },
        '[F6.1] state-change lookup err — row falls back to duplicate semantics',
      );
      eventcreateMetrics.csvImportStateChangeFallback(
        input.tenantId,
        'lookup_err',
      );
      return null;
    }
    if (existing.value === null) {
      // The receipt INSERT just committed, but no registration row
      // exists. This is an invariant violation: either the receipt
      // landed in a different tenant scope, or a concurrent admin
      // archived the registration between the receipt INSERT and
      // this lookup. Emit error-level signal — root cause must be
      // diagnosed before recurrence.
      logger.error(
        {
          event: 'f6_csv_state_change_lookup_missing',
          tenantId: input.tenantId,
          rowNumber: parsed.rowNumber,
          eventId: input.selectedEvent.eventId,
        },
        '[F6.1] receipt-duplicate but no persisted registration — invariant violation; row falls back to duplicate',
      );
      eventcreateMetrics.csvImportStateChangeFallback(
        input.tenantId,
        'lookup_missing',
      );
      return null;
    }
    const persisted = existing.value;
    if (persisted.ticket.paymentStatus === parsed.row.payment_status) {
      return null;
    }

    const update = await repo.updatePaymentStatus(
      input.tenantId,
      persisted.registrationId,
      parsed.row.payment_status,
    );
    if (!update.ok) {
      logger.warn(
        {
          event: 'f6_csv_state_change_update_err',
          tenantId: input.tenantId,
          rowNumber: parsed.rowNumber,
          registrationId: persisted.registrationId,
          err: update.error.kind,
        },
        '[F6.1] state-change UPDATE err — admin Notes-fix silently dropped; falls back to duplicate',
      );
      eventcreateMetrics.csvImportStateChangeFallback(
        input.tenantId,
        'update_err',
      );
      return null;
    }
    // CR-5 / I-5 (R1) — emit per-row state-change audit. PDPA Art. 30
    // + GDPR Art. 30 require traceable processing-records for payment-
    // status mutations of an existing PII row. In-tx emit (via the
    // savepoint-scoped audit port) so audit + UPDATE either both
    // commit or both roll back atomically.
    const auditResult = await ports.audit.emit({
      eventType: 'csv_import_row_state_changed',
      tenantId: input.tenantId,
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: `CSV row ${parsed.rowNumber} payment_status ${update.value.previousPaymentStatus} → ${parsed.row.payment_status}`,
      payload: {
        severity: 'info',
        actorUserId: input.actorUserId,
        rowNumber: parsed.rowNumber,
        registrationId: persisted.registrationId,
        previousPaymentStatus: update.value.previousPaymentStatus,
        newPaymentStatus: parsed.row.payment_status,
        rowHash: parsed.rowHash,
      },
    });
    if (!auditResult.ok) {
      // State-change audit failure: roll back the savepoint by
      // throwing — the FR-018 contract requires the UPDATE be
      // forensically traceable. The outer catch converts to
      // `kind:'row_failed'` so admin sees the failure clearly.
      throw new TxStageError(
        'audit_emit',
        `csv_import_row_state_changed audit emit failed: ${auditResult.error.kind}`,
      );
    }
    return {
      kind: 'state_changed',
      rowNumber: parsed.rowNumber,
      previousPaymentStatus: update.value.previousPaymentStatus,
      newPaymentStatus: parsed.row.payment_status,
    };
  } catch (e) {
    // CR-8 (R1 — silent-failure): never swallow silently. Log
    // structured error + emit metric. State-change path failure
    // means admin's payment_status fix is silently dropped — must
    // be visible to SRE alerting.
    logger.error(
      {
        event: 'f6_csv_state_change_threw',
        tenantId: input.tenantId,
        rowNumber: parsed.rowNumber,
        attendeeEmail: parsed.row.attendee_email,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] state-change probe threw — row falls back to duplicate; admin re-upload required',
    );
    eventcreateMetrics.csvImportStateChangeFallback(input.tenantId, 'threw');
    return null;
  }
}

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

// `processBatch` filters out parser-rejected rows before reaching this
// helper, so `parsed.ok` is guaranteed true on entry.
type ParsedOkRow = Extract<ParsedRow, { ok: true }>;

async function processOneRowInSavepoint(
  parsed: ParsedOkRow,
  input: ImportCsvInput,
  batchPorts: ImportCsvTxScopedPorts,
  deps: ImportCsvDeps,
): Promise<RowOutcome> {
  try {
    return await batchPorts.runRowInSavepoint(async (ports) => {
      // (a) Idempotency receipt — silent skip on duplicate per round-2
      //     R3 (CSV duplicates from admin re-upload; not webhook replay).
      //
      // F6.1 Phase 4 US2 (T033) — Cancellation rows BYPASS the receipt
      // entirely: a previous Attending row for the same attendee shares
      // the same rowHash (the canonical key omits payment_status), so the
      // receipt would dedupe the cancel re-upload. Bypassing routes the
      // row straight into `processAttendeeInTx` so the FR-018 refund
      // branch can flip an existing paid row + emit the credit-back
      // audit. First-time Cancellation rows (no prior registration) land
      // as a refunded ghost row — harmless side effect: no quota effect,
      // no audit emit (matchedMember+counted gates remain in effect).
      if (!parsed.intendedStateChange) {
        const receipt = await ports.idempotencyStore.tryInsert({
          tenantId: input.tenantId,
          source: 'eventcreate_csv',
          requestId: parsed.rowHash,
        });
        if (!receipt.ok) {
          // Surface the precise stage to dashboards via TxStageError so
          // SREs alerting on `failureStage='idempotency_receipt'` see
          // the idempotency-store outage as its own class — not folded
          // into the catch-all `'unknown'` bucket.
          throw new TxStageError(
            'idempotency_receipt',
            `idempotency receipt insert failed: ${receipt.error.message}`,
          );
        }
        if (!receipt.value.wasFresh) {
          // T031 (F6.1 Phase 4 US2) — receipt duplicate doesn't always
          // mean "no-op". When the incoming row's payment_status differs
          // from the persisted row (e.g. admin re-uploaded after fixing
          // the Notes cell), apply a state-change UPDATE before returning.
          // Refund transitions go through markRefunded + the FR-018
          // credit-back path; non-refund payment_status changes go
          // through updatePaymentStatus (no quota effect).
          const stateChange = await maybeApplyStateChange(
            parsed,
            input,
            ports,
          );
          if (stateChange !== null) return stateChange;
          return { kind: 'duplicate' as const, rowNumber: parsed.rowNumber };
        }
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
          tenantId: input.tenantId,
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
            // F6.1 (FR-009 dedicated column) — `pdpaConsentAcknowledged`
            // threaded through processAttendeeInTx → registrations repo
            // → `event_registrations.attendee_pdpa_consent_acknowledged`
            // BOOLEAN NULL column added by migration 0140. EventCreate
            // adapter rows carry true/false/null per FR-009 classifier;
            // generic-CSV rows omit (null at the column).
            pdpaConsentAcknowledged: parsed.pdpaConsentAcknowledged,
            metadata: {},
          },
        },
        ports,
      );

      // F6.1 Phase 4 US2 (T033) — first-time Cancellation has no prior
      // registration to refund. Roll back the savepoint (undo the
      // refunded ghost row that `insertOnConflictDoNothing` just
      // created) by raising the marker error; the outer catch maps it
      // to `kind:'skipped'` so the row flows into `rowsSkipped` (NOT
      // `rowsFailed` / `rowsProcessed`). Audit-quiet: no
      // `csv_import_row_failed` emit.
      if (parsed.intendedStateChange && result.isNewRegistration) {
        throw new CancellationSkipMarker(
          parsed.rowNumber,
          parsed.row.attendee_email,
        );
      }

      return {
        kind: 'inserted' as const,
        rowNumber: parsed.rowNumber,
        matchType: result.matchType,
        eventCreated: result.eventCreated,
      };
    });
  } catch (e) {
    // F6.1 Phase 4 US2 (T033) — first-time Cancellation (no prior
    // registration). Savepoint rolled back; surface as a `skipped`
    // outcome so the row flows into `rowsSkipped` instead of
    // `rowsFailed`.
    if (isCancellationSkip(e)) {
      // CR-10 (R1 — silent-failure): emit a low-severity forensic
      // event so support can reconstruct WHY this row appears in
      // `rowsSkipped` (vs the EventCreate Status filter). Audit emit
      // failure is non-blocking — this is informational forensics,
      // not a strict-audit-invariant surface.
      await safeEmitCancellationNoPrior(deps, input, e.rowNumber, e.email);
      return {
        kind: 'skipped',
        rowNumber: e.rowNumber,
        reason: `Skipped: Status=Cancelled without prior registration for ${e.email} (no-op)`,
      };
    }
    // Savepoint rolled back; outer tx + other rows preserved. Preserve
    // `TxStageError.stage` taxonomy on BOTH the `RowOutcome.row_failed`
    // field AND the `csv_import_row_failed` audit payload so dashboards
    // can alert on `audit_emit` failures (security-critical).
    const reason = e instanceof Error ? e.message : String(e);
    const failureStage: FailureStage =
      e instanceof TxStageError ? e.stage : 'unknown';
    await safeEmitRowFailed(
      deps,
      input,
      parsed.rowNumber,
      reason,
      '',
      failureStage,
    );
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
  const dbRows: Array<{ index: number; row: ParsedOkRow }> = [];
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i] as ParsedRow;
    if (!row.ok) {
      // F6.1 — `Skipped:` rows (EventCreate FR-007 Status filter) flow
      // into the `rowsSkipped` counter and DO NOT emit
      // `csv_import_row_failed` audit (they're EXPECTED non-attending
      // statuses, not security/availability events worth alerting on).
      if (isSkippedParserRow(row.reason)) {
        outcomes[i] = {
          kind: 'skipped',
          rowNumber: row.rowNumber,
          reason: row.reason,
        };
      } else {
        await safeEmitRowFailed(deps, input, row.rowNumber, row.reason, row.rawExcerpt);
        outcomes[i] = {
          kind: 'parse_failed',
          rowNumber: row.rowNumber,
          reason: row.reason,
        };
      }
    } else {
      dbRows.push({ index: i, row });
    }
  }

  if (dbRows.length === 0) {
    return outcomes;
  }

  // Open ONE outer tx for the whole batch. Each row runs in its own
  // SAVEPOINT via `runRowInSavepoint` so per-row failures don't poison
  // the batch.
  //
  // Collect outcomes into a TENTATIVE buffer inside the tx callback;
  // promote to the returned `outcomes` array only AFTER `runInTenantTx`
  // resolves successfully (outer COMMIT acknowledged). If the tx
  // throws at any point — row, savepoint, or final-COMMIT (deferred
  // constraint, network drop, serialisation conflict) — Postgres
  // rolls back ALL row effects and the catch block marks every dbRow
  // as `row_failed`. This prevents the ghost-row reporting bug where
  // the summary claimed success for rows the COMMIT later discarded.
  const tentativeOutcomes: RowOutcome[] = new Array(dbRows.length);
  try {
    await deps.runInTenantTx(input.tenantId, async (batchPorts) => {
      // F6.1 (Feature 013 · plan checkpoint) — per-(tenant, event)
      // advisory lock at outer-batch-tx start. Namespace `csv-import:`
      // is disjoint from F4 `invoicing:`, F5 `payments:`, F7
      // `broadcasts:`, F8 `renewals:` per advisory-lock-namespacing
      // convention. Serialises concurrent imports targeting the SAME
      // (tenant, event) — second admin's batch waits until the first
      // admin's batch commits (or rolls back).
      //
      // Trade-off: within a single import, the 3 batch-workers also
      // serialise (each acquires the same lock). At SC-006 1k-row
      // envelope this is ~10s wall-clock (10 batches × ~1s each) vs
      // ~3.3s parallel; acceptable for correctness over throughput
      // when correctness means "two concurrent admins can't both
      // commit half-overlapping registrations and confuse the
      // idempotency-receipt PK".
      //
      // pg_advisory_xact_lock auto-releases at tx-end (commit OR
      // rollback) — no need for explicit unlock.
      await batchPorts.advisoryLockAcquirer.acquire(
        asLockKey(`csv-import:${input.tenantId}:${input.selectedEvent.eventId}`),
      );
      for (let i = 0; i < dbRows.length; i++) {
        const { row } = dbRows[i]!;
        tentativeOutcomes[i] = await processOneRowInSavepoint(
          row,
          input,
          batchPorts,
          deps,
        );
      }
    });
    for (let i = 0; i < dbRows.length; i++) {
      const { index } = dbRows[i]!;
      outcomes[index] = tentativeOutcomes[i]!;
    }
  } catch (e) {
    // Batch-level catastrophic failure (tx-open failed, RLS denial —
    // Constitution Principle I bug signal — pool exhaustion, deadlock,
    // deferred-constraint COMMIT failure, network drop mid-COMMIT).
    // Postgres rolls back ALL row effects in the batch (inserted +
    // duplicate-receipt inserts alike). Mark every dbRow as failed in
    // the returned outcomes — but preserve savepoint-thrown rows'
    // original `failureStage` taxonomy (event_upsert / etc.) so SRE
    // dashboards keep the root-cause signal intact.
    //
    // Duplicate-audit guard: rows whose savepoint already emitted
    // `csv_import_row_failed` via `processOneRowInSavepoint`'s catch
    // (i.e., `tentativeOutcomes[i].kind === 'row_failed'`) must NOT
    // get a second fan-out audit emit. Otherwise SRE rate alerts
    // double-count and forensic reviewers see contradictory
    // narratives (`event_upsert` vs `batch_tx_aborted`) for the same
    // rowNumber.
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
      '[F6] CSV batch tx aborted — all rows in batch failed; investigate RLS / pool / deadlock / commit signals',
    );
    // Parallel fan-out (vs serial `await` loop) — 100x faster forensic
    // emit on N=100-row batches. `safeEmitRowFailed` swallows internal
    // errors so `Promise.allSettled` is defensive; `Promise.all` would
    // also work today, kept as `allSettled` in case the internal
    // swallow is later refactored away.
    // The filter callback's positional index `i` is the position in
    // `dbRows` — which is ALSO the index into `tentativeOutcomes` by
    // construction (filled in the inner loop at line ~420:
    // `tentativeOutcomes[i] = await processOneRowInSavepoint(dbRows[i]...)`).
    // Skip emit when a row already emitted via its savepoint catch —
    // otherwise SRE dashboards over-count and forensic reviewers see
    // contradictory failureStage narratives for the same rowNumber.
    await Promise.allSettled(
      dbRows
        .filter((_dbRow, i) => tentativeOutcomes[i]?.kind !== 'row_failed')
        .map(({ row }) =>
          safeEmitRowFailed(
            deps,
            input,
            row.rowNumber,
            `batch tx aborted: ${reason}`,
            '',
          ),
        ),
    );
    for (let i = 0; i < dbRows.length; i++) {
      const { index, row } = dbRows[i]!;
      const tentative = tentativeOutcomes[i];
      // Preserve the savepoint-catch'd outcome for rows that already
      // resolved as row_failed — they carry the precise `failureStage`
      // taxonomy from `processAttendeeInTx.TxStageError`, which is
      // strictly more informative than the catch-all batch reason.
      if (tentative?.kind === 'row_failed') {
        outcomes[index] = tentative;
      } else {
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
 * Record an audit-emit failure (either `Result.err` or thrown exception)
 * to the dedicated `csvImportAuditEmitFailed` counter + a structured
 * `logger.error`. C-2 (Round 1 comment-analyzer): updated for the 6
 * call sites — row-failed × {err, throw}, completed × {err, throw},
 * mismatch-override × {err, throw} (CR-4 Round 1 wired override paths
 * to use this helper instead of inline-duplicated emit + mislabelled
 * 'csv_import_completed' metric label).
 */
function recordAuditEmitFailure(
  tenantId: TenantId,
  eventType:
    | 'csv_import_row_failed'
    | 'csv_import_completed'
    | 'csv_import_event_mismatch_overridden'
    | 'csv_import_row_cancelled_no_prior'
    | 'csv_import_row_state_changed',
  logEvent: string,
  logMessage: string,
  // R1 S-5 (silent-failure): context now carries `actorUserId` so
  // forensics can attribute the audit-emit failure to the specific
  // admin who triggered it. Each call-site MUST include it explicitly
  // (TypeScript-enforced via the Readonly<Record<string, unknown>>
  // type — string indexer permits but the audit caller does the
  // discipline at the call site).
  context: Readonly<Record<string, unknown>>,
): void {
  eventcreateMetrics.csvImportAuditEmitFailed(tenantId, eventType);
  logger.error({ event: logEvent, tenantId, ...context }, logMessage);
}

/**
 * Emit `csv_import_row_failed` audit; never throws. Audit-emit failure
 * is recorded via `recordAuditEmitFailure` so the row's forensic trio
 * (rowNumber + reason + rawRowExcerpt) survives in stderr even when
 * the DB write fails.
 */
async function safeEmitRowFailed(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  rowNumber: number,
  reason: string,
  rawExcerpt: string,
  failureStage: FailureStage = 'unknown',
): Promise<void> {
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_row_failed',
      tenantId: input.tenantId,
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
        failureStage,
      },
    });
    if (!result.ok) {
      recordAuditEmitFailure(
        input.tenantId,
        'csv_import_row_failed',
        'f6_csv_row_failed_audit_emit_failed',
        '[F6] csv_import_row_failed audit emit failed — forensic trail loss; row outcome still tracked in summary counter',
        {
          actorUserId: input.actorUserId,
          rowNumber,
          reason: reason.slice(0, 500),
          auditErrKind: result.error.kind,
        },
      );
    }
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_row_failed',
      'f6_csv_row_failed_audit_emit_threw',
      '[F6] csv_import_row_failed audit emitter threw — forensic trail loss',
      {
        actorUserId: input.actorUserId,
        rowNumber,
        reason: reason.slice(0, 500),
        err: e instanceof Error ? e.message : String(e),
      },
    );
  }
}

/**
 * CR-10 (R1 — silent-failure) — emit a low-severity forensic event
 * when a first-time Cancellation row is skipped. Audit-quiet on emit
 * failure (informational only, not a strict-audit-invariant surface).
 */
async function safeEmitCancellationNoPrior(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  rowNumber: number,
  emailHash: string,
): Promise<void> {
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_row_cancelled_no_prior',
      tenantId: input.tenantId,
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: `CSV row ${rowNumber} Status=Cancelled but no prior registration — skipped`,
      payload: {
        severity: 'info',
        actorUserId: input.actorUserId,
        rowNumber,
        // Hash the email so the forensic log does not surface raw
        // attendee PII. SHA-256 prefix is sufficient for incident
        // correlation against the source CSV.
        attendeeEmailHash: emailHash,
      },
    });
    if (!result.ok) {
      recordAuditEmitFailure(
        input.tenantId,
        'csv_import_row_cancelled_no_prior',
        'f6_csv_row_cancelled_no_prior_audit_emit_failed',
        '[F6.1] csv_import_row_cancelled_no_prior audit emit failed — forensic trail loss (informational)',
        { rowNumber, auditErrKind: result.error.kind },
      );
    }
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_row_cancelled_no_prior',
      'f6_csv_row_cancelled_no_prior_audit_emit_threw',
      '[F6.1] csv_import_row_cancelled_no_prior audit emitter threw — forensic trail loss (informational)',
      { rowNumber, err: e instanceof Error ? e.message : String(e) },
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
  const recordId = input.recordId ?? asCsvImportRecordId(randomUUID());

  // F6.1 — Phase 1: parse the CSV stream with format detection.
  // The new `parseStreamWithFormat` method detects EventCreate vs
  // generic format from the header, translates EventCreate rows via
  // the T010 adapter, and merges `selectedEvent` into every row.
  const eventContext = {
    externalId: input.selectedEvent.externalId,
    name: input.selectedEvent.name,
    startDate: input.selectedEvent.startDate,
    category: input.selectedEvent.category,
  };

  // TYPE-D3 (Round 1) — port method is now required; legacy fallback
  // branch removed. Phase 7 mocks provide it via
  // `wrapParseStreamAsFormat` helper.
  let parsed: Awaited<ReturnType<CsvImporter['parseStreamWithFormat']>>;
  try {
    parsed = await deps.csvImporter.parseStreamWithFormat({
      bytes: input.bytes,
      eventContext,
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
      // T053 — pass through `adapterEnabled` from composition. The
      // importer treats `undefined` as `true` (normal detection).
      ...(input.adapterEnabled !== undefined && {
        adapterEnabled: input.adapterEnabled,
      }),
    });
  } catch (e) {
    // R1 I-2 (silent-failure): structured log capture of the raw
    // message + stack to stderr; admin-facing message is generic to
    // prevent internal-details leak (e.g., Drizzle "relation does
    // not exist" or Postgres connection-string fragments).
    logger.error(
      {
        event: 'f6_csv_parser_threw',
        tenantId: input.tenantId,
        recordId,
        err: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      },
      '[F6.1] CSV parser threw — admin sees generic error; investigate stderr trail',
    );
    eventcreateMetrics.csvImportParserThrew(input.tenantId);
    return {
      kind: 'unexpected_error',
      message: 'parser failed; please re-upload or contact support',
    };
  }
  if (!parsed.ok) {
    if (parsed.error.kind === 'invalid_header') {
      return {
        kind: 'invalid_header',
        missingColumns: parsed.error.missingColumns,
      };
    }
    const parserReason =
      'reason' in parsed.error && typeof parsed.error.reason === 'string'
        ? parsed.error.reason
        : null;
    return {
      kind: 'unexpected_error',
      message: parserReason
        ? `parser error: ${parsed.error.kind} — ${parserReason}`
        : `parser error: ${parsed.error.kind}`,
    };
  }

  const sourceFormat: CsvAdapterMode = parsed.value.format;
  const unknownColumns = parsed.value.unknownColumns;

  // I2 (Round 1 — code-reviewer): emit the rollback-trigger signal
  // per spec § Rollback Plan + SC-008. SRE watches:
  //   rate(eventcreate_csv_adapter_mode_detected_total{format="generic_csv"})
  // unexpectedly spike → EventCreate capitalization drifted, adapter
  // silently falling through. Conversely an `eventcreate_csv` rate
  // drop signals time to flip FEATURE_F6_EVENTCREATE_ADAPTER=false.
  eventcreateMetrics.csvImportAdapterModeDetected(
    input.tenantId,
    sourceFormat,
  );

  // T052 (F6.1 Phase 6) — per-upload aggregate pino log of unknown
  // EventCreate columns (FR-012). Emitted ONCE per import (not per
  // row) ONLY when the adapter detected unknown columns; the product
  // team reviews these to track EventCreate schema evolution + decide
  // whether to add a column to the EVENTCREATE_KNOWN_COLUMNS set in
  // the adapter. Excludes the generic-CSV path because Phase 7's
  // strict schema silently drops unknown columns (no equivalent
  // observability requirement).
  if (sourceFormat === 'eventcreate_csv' && unknownColumns.length > 0) {
    try {
      // R1 S-1 (code-reviewer): sanitize unknown column names so a
      // CRLF-injection or oversized header can't pollute the log
      // stream. Cap each name to 64 chars + strip control chars.
      const sanitisedColumns = unknownColumns
        .slice(0, 50)
        .map((c) => c.slice(0, 64).replace(/[\r\n\t]/g, '_'));
      logger.info(
        {
          event: 'f6_eventcreate_adapter_unknown_columns',
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          recordId,
          distinctUnknownColumns: sanitisedColumns,
          unknownColumnCount: unknownColumns.length,
        },
        '[F6.1] EventCreate CSV import contained unknown columns — review for future adapter extension',
      );
    } catch {
      // R1 I-7 (silent-failure): pino transport failure must not
      // abort the import. Observability degraded; correctness preserved.
    }
  }

  // F6.1 — Phase 2: collect rows from the async stream into an array.
  // SC-006 envelope is 1,000 rows; bench at 5,000 rows shows peak heap
  // <500 MiB so a single collect is safe.
  const rows: ParsedRow[] = [];
  for await (const r of parsed.value.rows) {
    rows.push(r);
  }
  const rowsTotal = rows.length;

  // F6.1 — Phase 2b: compute attendee fingerprint over ok===true rows
  // (the EventCreate adapter already applied the FR-007 Status filter
  // upstream — non-attending rows are ok:false). Generic-format rows
  // also use email-only fingerprinting per FR-019a.
  const attendingEmails = rows
    .filter((r): r is Extract<ParsedRow, { ok: true }> => r.ok)
    .map((r) => r.row.attendee_email);
  const attendeeFingerprint = computeAttendeeFingerprintFromEmails(
    attendingEmails,
  );

  // F6.1 — Phase 2c: FR-019b safety-net query. Skip if fingerprint is
  // null (zero attending rows — nothing to match).
  let priorImports: ReadonlyArray<PriorImportMatch> = [];
  if (attendeeFingerprint !== null) {
    const since = new Date(startedAtMs - 30 * 24 * 60 * 60 * 1000);
    try {
      const result = await deps.withImportRecordsTx(
        input.tenantId,
        async (repo) =>
          repo.findByFingerprintAcrossEvents({
            tenantId: input.tenantId,
            fingerprint: attendeeFingerprint,
            currentEventId: input.selectedEvent.eventId,
            since,
          }),
      );
      if (result.ok) {
        priorImports = result.value;
      } else {
        logger.warn(
          {
            event: 'f6_csv_safety_net_query_failed',
            tenantId: input.tenantId,
            fingerprint: attendeeFingerprint,
            eventId: input.selectedEvent.eventId,
            eventExternalId: input.selectedEvent.externalId,
            err: result.error.kind,
          },
          '[F6.1] safety-net fingerprint query failed — proceeding without warning (fail-open)',
        );
        eventcreateMetrics.csvImportSafetyNetFallback(
          input.tenantId,
          'result_err',
        );
      }
    } catch (e) {
      logger.warn(
        {
          event: 'f6_csv_safety_net_query_threw',
          tenantId: input.tenantId,
          eventId: input.selectedEvent.eventId,
          eventExternalId: input.selectedEvent.externalId,
          err: e instanceof Error ? e.message : String(e),
        },
        '[F6.1] safety-net fingerprint query threw — fail-open',
      );
      eventcreateMetrics.csvImportSafetyNetFallback(input.tenantId, 'threw');
    }
  }

  // F6.1 — Phase 2d: branch on safety-net result.
  if (priorImports.length > 0 && !input.forceProceed) {
    // Return event_mismatch_warning — ZERO side effects per FR-019b.
    // No csv_import_records insert, no audit emit, no batches.
    return {
      kind: 'event_mismatch_warning',
      priorImports,
    };
  }

  // F6.1 — Phase 2e: if forceProceed bypasses a real safety-net hit,
  // emit `csv_import_event_mismatch_overridden` audit BEFORE batches
  // commit (so the override is auditable even if the import fails).
  //
  // CR-9 (R1 — silent-failure): strict-audit invariant. If the
  // override audit emit fails, REFUSE to proceed with the import —
  // a forceProceed import without a forensic trail breaks the
  // FR-019c contract. Admin retries via the same form; the audit
  // store may have recovered by then.
  if (priorImports.length > 0 && input.forceProceed) {
    const emitted = await tryEmitMismatchOverride(
      deps,
      input,
      recordId,
      priorImports,
    );
    if (!emitted) {
      return {
        kind: 'unexpected_error',
        message:
          'override audit emit failed — refusing to proceed without forensic trail; please retry',
      };
    }
  }

  // F6.1 — Phase 2f: insert placeholder csv_import_records row. Uses
  // its OWN tenant-scoped tx (separate from the batch txs) so a failed
  // batch doesn't roll back the import-record itself.
  const originalFilename = (input.originalFilename ?? 'upload.csv').slice(
    0,
    512,
  );
  const originalSizeBytes = input.bytes.byteLength;
  try {
    const insertResult = await deps.withImportRecordsTx(
      input.tenantId,
      async (repo) =>
        repo.insert({
          recordId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          eventId: input.selectedEvent.eventId,
          sourceFormat,
          originalFilename,
          originalSizeBytes,
        }),
    );
    if (!insertResult.ok) {
      logger.error(
        {
          event: 'f6_csv_import_records_insert_failed',
          tenantId: input.tenantId,
          recordId,
          err: insertResult.error.kind,
        },
        '[F6.1] csv_import_records placeholder insert failed — proceeding with import; final-outcome update will surface the error',
      );
    }
  } catch (e) {
    logger.error(
      {
        event: 'f6_csv_import_records_insert_threw',
        tenantId: input.tenantId,
        recordId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] csv_import_records placeholder insert threw — proceeding with import',
    );
  }

  // F6.1 — Phase 3: split into batches of `batchSize`, process
  // `batchConcurrency` batches in parallel via a sliding-window
  // scheduler. Each batch opens 1 outer tx + iterates rows via
  // SAVEPOINTs (tasks.md T094).
  const summary = {
    rowsProcessed: 0,
    rowsAlreadyImported: 0,
    rowsSkipped: 0,
    rowsStateChanged: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    matchCounts: zeroMatchCounts(),
    errorRows: [] as ImportSummaryErrorRow[],
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
          case 'skipped':
            summary.rowsSkipped += 1;
            summary.errorRows.push({
              rowNumber: outcome.rowNumber,
              reason: outcome.reason,
            });
            break;
          case 'duplicate':
            summary.rowsAlreadyImported += 1;
            break;
          case 'state_changed':
            // T031: receipt-duplicate that triggered an UPDATE of
            // payment_status. Count separately from `rowsAlreadyImported`
            // so admins see the re-upload had EFFECT (not silent skip).
            summary.rowsStateChanged += 1;
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
              failureStage: outcome.failureStage,
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

  const durationMs = Date.now() - startedAtMs;
  // F6.1 — `rowsFailed` excludes Status-filter skipped rows (those flow
  // into rowsSkipped). errorRows still includes both for the response
  // body so the admin sees a complete picture; the count semantics are
  // documented in the contract response shape.
  const rowsFailed = Math.max(
    0,
    summary.errorRows.length - summary.rowsSkipped,
  );

  // F6.1 — Phase 4a: write error-CSV blob if there are failures.
  // (Skipped rows are part of `errorRows` but US5 admins typically want
  // to see them too for a complete error report — write all errorRows
  // when ANY failure exists.) Failures here are observability events,
  // not request-failure events — admin still sees the row-by-row
  // result.
  let errorCsvAvailable = false;
  let errorCsvBlobUrl: string | null = null;
  if (rowsFailed > 0 && summary.errorRows.length > 0) {
    const csvBytes = serializeErrorRowsToCsv(summary.errorRows);
    try {
      const putResult = await deps.errorCsvStore.put({
        tenantId: input.tenantId,
        recordId,
        csvBytes,
        // 30-day TTL per data-model.md § 1 lifecycle step 3.
        expiresAt: new Date(startedAtMs + 30 * 24 * 60 * 60 * 1000),
      });
      if (putResult.ok) {
        errorCsvAvailable = true;
        errorCsvBlobUrl = putResult.value.blobUrl;
      } else {
        // R1 I-3 (silent-failure): elevate to error + emit metric.
        // The error rows are lost from the US5 download surface for
        // this import (admin must re-run); SRE alerts on `rate > 0`.
        logger.error(
          {
            event: 'f6_csv_error_csv_blob_put_failed',
            tenantId: input.tenantId,
            recordId,
            rowsFailed,
            err: putResult.error.kind,
          },
          '[F6.1] error-CSV blob upload FAILED — US5 download unavailable for this import; admin must re-run to regenerate',
        );
        eventcreateMetrics.csvErrorCsvUploadFailed(input.tenantId);
      }
    } catch (e) {
      logger.error(
        {
          event: 'f6_csv_error_csv_blob_put_threw',
          tenantId: input.tenantId,
          recordId,
          err: e instanceof Error ? e.message : String(e),
        },
        '[F6.1] error-CSV blob put THREW — US5 download unavailable; investigate Vercel Blob outage',
      );
      eventcreateMetrics.csvErrorCsvUploadFailed(input.tenantId);
    }
  }

  // F6.1 — Phase 4b: classify the FINAL outcome that the
  // csv_import_records.outcome column should carry. `completed` =
  // no failures; `partial_failure` = at least one row failed but the
  // budget held; `timeout` = budget tripped before all batches drained.
  const recordOutcome: 'completed' | 'partial_failure' | 'timeout' =
    timeBudgetExceeded
      ? 'timeout'
      : rowsFailed > 0
      ? 'partial_failure'
      : 'completed';

  // F6.1 — Phase 4c: build adapter metadata for the column (FR-012
  // unknown columns + sourceFormat).
  const eventcreateAdapterMetadata: Record<string, unknown> | null =
    sourceFormat === 'eventcreate_csv'
      ? {
          sourceFormat,
          unknownColumns: unknownColumns.slice(0, 50),
        }
      : null;

  // F6.1 — Phase 4d: update csv_import_records with final counts.
  //
  // When the placeholder INSERT never landed (FK violation, RLS denial,
  // pool exhaustion at Phase 2f), the UPDATE here affects zero rows.
  // The repo returns `err({kind:'not_found'})` so we can branch into a
  // recovery INSERT with the final outcome — without this, admins would
  // see success in the UI but the import-history row would be missing
  // and the FR-019c forensic invariant would silently break.
  //
  // `historyPersisted` is propagated to the outcome so the route + UI
  // can degrade the recordId surface when the history row is lost —
  // admins quoting `recordId` to support will not find a matching row
  // unless this stays `true` end-to-end.
  let historyPersisted = true;
  try {
    const updateResult = await deps.withImportRecordsTx(
      input.tenantId,
      async (repo) => {
        const r = await repo.updateOutcome({
          recordId,
          tenantId: input.tenantId,
          rowsTotal,
          rowsProcessed: summary.rowsProcessed,
          rowsAlreadyImported: summary.rowsAlreadyImported,
          rowsSkipped: summary.rowsSkipped,
          rowsFailed,
          outcome: recordOutcome,
          durationMs,
          attendeeFingerprint,
          eventcreateAdapterMetadata,
        });
        if (!r.ok) return r;
        // Persist the error-CSV blob URL when available.
        if (errorCsvBlobUrl !== null) {
          const expiresAt = new Date(startedAtMs + 30 * 24 * 60 * 60 * 1000);
          return repo.setErrorCsvBlob({
            recordId,
            tenantId: input.tenantId,
            errorCsvBlobUrl,
            errorCsvExpiresAt: expiresAt,
          });
        }
        return r;
      },
    );
    if (!updateResult.ok) {
      historyPersisted = false;
      if (updateResult.error.kind === 'not_found') {
        // CR-5 recovery — placeholder never landed; try a single
        // INSERT with final counts. If THAT fails too the history row
        // is permanently lost (admin still got their import; only
        // the audit/history is degraded).
        try {
          const recoveryResult = await deps.withImportRecordsTx(
            input.tenantId,
            async (repo) => {
              const ins = await repo.insert({
                recordId,
                tenantId: input.tenantId,
                actorUserId: input.actorUserId,
                eventId: input.selectedEvent.eventId,
                sourceFormat,
                originalFilename,
                originalSizeBytes,
              });
              if (!ins.ok) return ins;
              const upd = await repo.updateOutcome({
                recordId,
                tenantId: input.tenantId,
                rowsTotal,
                rowsProcessed: summary.rowsProcessed,
                rowsAlreadyImported: summary.rowsAlreadyImported,
                rowsSkipped: summary.rowsSkipped,
                rowsFailed,
                outcome: recordOutcome,
                durationMs,
                attendeeFingerprint,
                eventcreateAdapterMetadata,
              });
              return upd;
            },
          );
          if (recoveryResult.ok) {
            historyPersisted = true;
            logger.warn(
              {
                event: 'f6_csv_import_records_recovery_succeeded',
                tenantId: input.tenantId,
                recordId,
              },
              '[F6.1] csv_import_records placeholder was lost; recovery INSERT succeeded — history row now reflects final outcome',
            );
          } else {
            logger.error(
              {
                event: 'f6_csv_import_records_recovery_failed',
                tenantId: input.tenantId,
                recordId,
                err: recoveryResult.error.kind,
              },
              '[F6.1] csv_import_records recovery INSERT also failed — import-history row permanently lost; rows committed are still safe',
            );
          }
        } catch (recoveryErr) {
          logger.error(
            {
              event: 'f6_csv_import_records_recovery_threw',
              tenantId: input.tenantId,
              recordId,
              err: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
            },
            '[F6.1] csv_import_records recovery INSERT threw',
          );
        }
      } else {
        logger.error(
          {
            event: 'f6_csv_import_records_update_failed',
            tenantId: input.tenantId,
            recordId,
            err: updateResult.error.kind,
          },
          '[F6.1] csv_import_records final-outcome update failed — placeholder row persists with stale unexpected_error outcome',
        );
      }
    }
  } catch (e) {
    historyPersisted = false;
    logger.error(
      {
        event: 'f6_csv_import_records_update_threw',
        tenantId: input.tenantId,
        recordId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] csv_import_records final-outcome update threw',
    );
  }
  // F6.1 — Phase 4e: emit per-import `csv_import_completed` audit on
  // both completed AND timeout paths with `sourceFormat` extension.
  await emitImportCompletedAudit({
    deps,
    input,
    summary: {
      rowsProcessed: summary.rowsProcessed,
      rowsAlreadyImported: summary.rowsAlreadyImported,
      eventsCreated: summary.eventsCreated,
      eventsUpdated: summary.eventsUpdated,
      matchCounts: summary.matchCounts,
      errorRows: summary.errorRows,
    },
    durationMs,
    timedOut: timeBudgetExceeded,
    sourceFormat,
  });

  if (timeBudgetExceeded) {
    return {
      kind: 'timeout',
      recordId,
      sourceFormat,
      // TYPE-D4 (Round 1) — partial summary surfaced so admins +
      // route handler aren't blind to which rows committed.
      summary: {
        rowsTotal,
        rowsProcessed: summary.rowsProcessed,
        rowsAlreadyImported: summary.rowsAlreadyImported,
        rowsSkipped: summary.rowsSkipped,
        rowsFailed,
        rowsStateChanged: summary.rowsStateChanged,
        eventsCreated: summary.eventsCreated,
        eventsUpdated: summary.eventsUpdated,
        matchCounts: summary.matchCounts,
        errorRows: summary.errorRows,
        durationMs,
      },
      errorCsvAvailable,
      historyPersisted,
    };
  }

  return {
    kind: 'completed',
    recordId,
    sourceFormat,
    errorCsvAvailable,
    historyPersisted,
    summary: {
      rowsTotal,
      rowsProcessed: summary.rowsProcessed,
      rowsAlreadyImported: summary.rowsAlreadyImported,
      rowsSkipped: summary.rowsSkipped,
      rowsFailed,
      rowsStateChanged: summary.rowsStateChanged,
      eventsCreated: summary.eventsCreated,
      eventsUpdated: summary.eventsUpdated,
      matchCounts: summary.matchCounts,
      errorRows: summary.errorRows,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// F6.1 — helper: serialize errorRows to CSV bytes
// ---------------------------------------------------------------------------

function serializeErrorRowsToCsv(
  errorRows: ReadonlyArray<ImportSummaryErrorRow>,
): Uint8Array {
  const lines: string[] = ['row_number,reason,failure_stage'];
  for (const row of errorRows) {
    const reason = csvEscape(row.reason);
    const stage = row.failureStage ?? '';
    lines.push(`${row.rowNumber},${reason},${stage}`);
  }
  const text = lines.join('\r\n') + '\r\n';
  return new TextEncoder().encode(text);
}

function csvEscape(s: string): string {
  // RFC 4180 — double-quote-wrap if the cell contains comma, quote, CR,
  // or LF; escape internal quotes by doubling.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// F6.1 — helper: emit mismatch-override audit (never throws)
// ---------------------------------------------------------------------------

/**
 * Emit the FR-019c `csv_import_event_mismatch_overridden` audit.
 *
 * CR-9 (R1 — silent-failure) — strict-audit invariant: when the
 * audit emit fails OR throws, return `false` so the caller can
 * REFUSE to proceed with the import. A forceProceed without a
 * forensic trail breaks the FR-019c contract; admin retry may
 * succeed against the same DB.
 *
 * Returns:
 *   - `true` on successful emit — caller proceeds with import.
 *   - `false` on emit failure (Result.err OR throw) — caller MUST
 *     abort the import to preserve forensic trail integrity.
 */
async function tryEmitMismatchOverride(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  recordId: CsvImportRecordId,
  priorImports: ReadonlyArray<PriorImportMatch>,
): Promise<boolean> {
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_event_mismatch_overridden',
      tenantId: input.tenantId,
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: `Admin overrode FR-019b event-mismatch safety net via force_proceed=true; ${priorImports.length} prior import(s) matched`,
      payload: {
        severity: 'warn',
        actorUserId: input.actorUserId,
        recordId,
        currentEventId: input.selectedEvent.eventId,
        priorRecordIds: priorImports.map((p) => p.recordId as string),
        priorEventIds: priorImports.map((p) => p.eventId),
        overriddenAt: new Date(),
      },
    });
    if (!result.ok) {
      recordAuditEmitFailure(
        input.tenantId,
        'csv_import_event_mismatch_overridden',
        'f6_csv_mismatch_override_audit_emit_failed',
        '[F6.1] csv_import_event_mismatch_overridden audit emit failed — REFUSING to proceed with import; admin must retry',
        {
          actorUserId: input.actorUserId,
          recordId,
          priorImportsCount: priorImports.length,
          auditErrKind: result.error.kind,
        },
      );
      return false;
    }
    return true;
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_event_mismatch_overridden',
      'f6_csv_mismatch_override_audit_emit_threw',
      '[F6.1] csv_import_event_mismatch_overridden audit emitter threw — REFUSING to proceed with import; admin must retry',
      {
        actorUserId: input.actorUserId,
        recordId,
        priorImportsCount: priorImports.length,
        err: e instanceof Error ? e.message : String(e),
      },
    );
    return false;
  }
}

interface EmitImportCompletedAuditArgs {
  readonly deps: ImportCsvDeps;
  readonly input: ImportCsvInput;
  readonly summary: {
    readonly rowsProcessed: number;
    readonly rowsAlreadyImported: number;
    readonly eventsCreated: number;
    readonly eventsUpdated: number;
    readonly matchCounts: Record<MatchType, number>;
    readonly errorRows: ReadonlyArray<ImportSummaryErrorRow>;
  };
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** F6.1 — adapter mode detected at parse time. */
  readonly sourceFormat: CsvAdapterMode;
}

async function emitImportCompletedAudit(
  args: EmitImportCompletedAuditArgs,
): Promise<void> {
  const { deps, input, summary, durationMs, timedOut, sourceFormat } = args;
  const completedAuditContext = {
    rowsProcessed: summary.rowsProcessed,
    rowsAlreadyImported: summary.rowsAlreadyImported,
    errorRowCount: summary.errorRows.length,
    durationMs,
    timedOut,
  };
  const summaryText = timedOut
    ? `CSV import TIMED OUT after ${durationMs}ms: ${summary.rowsProcessed} processed, ${summary.rowsAlreadyImported} idempotency-skipped, ${summary.errorRows.length} errors (partial commit preserved; re-upload is idempotent)`
    : `CSV import completed: ${summary.rowsProcessed} processed, ${summary.rowsAlreadyImported} idempotency-skipped, ${summary.errorRows.length} errors in ${durationMs}ms`;
  try {
    const result = await deps.emitStandalone({
      eventType: 'csv_import_completed',
      tenantId: input.tenantId,
      actorType: 'csv_import',
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      summary: summaryText,
      payload: {
        severity: timedOut ? 'warn' : 'info',
        actorUserId: input.actorUserId,
        rowsProcessed: summary.rowsProcessed,
        rowsAlreadyImported: summary.rowsAlreadyImported,
        eventsCreated: summary.eventsCreated,
        eventsUpdated: summary.eventsUpdated,
        matchCounts: summary.matchCounts,
        errorRowCount: summary.errorRows.length,
        durationMs,
        timedOut,
        sourceFormat,
      },
    });
    if (!result.ok) {
      recordAuditEmitFailure(
        input.tenantId,
        'csv_import_completed',
        'f6_csv_import_completed_audit_emit_failed',
        '[F6] csv_import_completed audit emit failed — entire-import forensic record lost; DB side effects committed but no audit row exists',
        { ...completedAuditContext, auditErrKind: result.error.kind },
      );
    }
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_completed',
      'f6_csv_import_completed_audit_emit_threw',
      '[F6] csv_import_completed audit emitter threw — entire-import forensic record lost',
      { ...completedAuditContext, err: e instanceof Error ? e.message : String(e) },
    );
  }
}
