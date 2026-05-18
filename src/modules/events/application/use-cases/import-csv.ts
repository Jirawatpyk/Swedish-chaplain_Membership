/**
 * `importCsv` use-case (F6 Application).
 *
 * Orchestrates CSV bulk-import via the shared `processAttendeeInTx`
 * helper so the CSV pipeline yields byte-equivalent rows to the
 * webhook pipeline (FR-027 by construction).
 *
 * Pipeline: parse stream → split into 100-row batches → run 3 parallel
 * workers → each batch = 1 outer tx with per-row SAVEPOINT isolation →
 * emit `csv_import_completed` audit (standalone tx).
 *
 * Time-budget semantics: `timeBudgetMs` (default 55_000) gates "may a
 * worker start the NEXT batch?" — it does NOT mid-flight cancel a
 * running batch. Wall-clock can exceed budget by up to one batch's
 * duration; on breach the use-case returns `{kind:'timeout'}` after
 * in-flight batches drain. Committed rows persist (idempotent re-upload).
 *
 * Spec authority: contracts/csv-import-api.md § Processing semantics;
 * FR-026 / FR-027 / FR-028 / FR-029 / SC-006; research.md R8.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { formatErrorWithCause } from './_helpers/format-error-with-cause';
import { asLockKey } from '../ports/advisory-lock-acquirer';
import {
  applyQuotaEffect,
  buildQuotaLockKey,
} from './apply-quota-effect';
import { F6_FISCAL_YEAR_START_MONTH } from './_helpers/fiscal-year-constants';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { emitCreditBackViaStateChange } from './_helpers/emit-credit-back-pair';
import { isQuotaCountedStatus } from '../../domain/value-objects/payment-status';
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
  safeStringify,
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
   * count of re-uploaded rows whose
   * `payment_status` (Status-derived) differed from the persisted
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
       * `true` when the `csv_import_records` row was successfully
       * persisted (placeholder INSERT or CR-5 recovery INSERT). `false`
       * when BOTH the placeholder and recovery INSERT failed — the
       * rows committed are still safe, but admins quoting `recordId`
       * to support will not find a matching history row. The UI surface
       * SHOULD degrade the recordId chip / hide the "view history"
       * link when this is `false`.
       */
      readonly historyPersisted: boolean;
      /**
       * `true` when the per-import `csv_import_completed` audit row
       * was written. `false` when the standalone-tx emit failed — DB
       * side effects committed but the audit trail is incomplete for
       * THIS import. UI should surface a degraded audit-trail chip.
       */
      readonly auditCompletionEmitted: boolean;
      /**
       * R6.W / Round 5 staff-review R009 closure — `true` when the
       * FR-019b safety-net query (event-mismatch detector) failed
       * during this upload. The import proceeded fail-open (no
       * priorImports lookup ran), so the admin lacks the routine
       * "looks like you uploaded this to event X before" guard. UI
       * SHOULD surface a "duplicate-protection unavailable" chip so
       * the admin can manually verify the event selection before
       * trusting the import.
       */
      readonly safetyNetFailedOpen: boolean;
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
       * Carry partial summary + errorCsvAvailable on the timeout path
       * so admins are not blind to which rows committed. The DB-side
       * `csv_import_records` row IS updated with `outcome='timeout'` +
       * partial counts; this field exposes the same data to the route
       * handler.
       */
      readonly summary: ImportSummary;
      readonly errorCsvAvailable: boolean;
      /** See `completed.historyPersisted`. Same semantics. */
      readonly historyPersisted: boolean;
      /** See `completed.auditCompletionEmitted`. Same semantics. */
      readonly auditCompletionEmitted: boolean;
      /** See `completed.safetyNetFailedOpen`. Same semantics. */
      readonly safetyNetFailedOpen: boolean;
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
   * SAVEPOINT when called inside an existing transaction. Per Postgres
   * semantics, SET LOCAL propagates through savepoints — the outer
   * tx's `app.current_tenant` GUC remains active inside the savepoint,
   * so RLS continues to enforce tenant isolation. This is regression-
   * pinned by tests/integration/events/csv-savepoint-isolation.test.ts
   * which asserts the GUC propagation end-to-end on live Neon.
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
// Cancellation pre-existence marker
// ---------------------------------------------------------------------------
//
// Thrown inside a SAVEPOINT to roll back a first-time-Cancellation row
// (no prior registration exists — the FR-018 refund branch had nothing
// to flip, and the row that `insertOnConflictDoNothing` just created
// is a useless refunded ghost). The outer catch maps to a `skipped`
// row outcome (counted in `rowsSkipped`, NOT `rowsFailed`), audit-quiet
// — first-time cancellation is expected behaviour, not a failure.

// Symbol brand prevents collision with any future Error subclass
// named `CancellationSkipMarker` (3rd-party lib, cross-realm vm
// contexts). `instanceof` AND brand-equality both must hold.
const CANCELLATION_SKIP_BRAND = Symbol('f6.csv-skip.cancellation');

/**
 * Branded SHA-256 hex prefix so a future caller cannot accidentally
 * pass a raw email into a slot that expects a hash. Only
 * `hashAttendeeEmail` can construct values of this type — TypeScript
 * blocks plain-string assignment at compile time.
 */
type EmailHashPrefix = string & { readonly __emailHashPrefix: unique symbol };

/**
 * PDPA / GDPR Art. 5(1)(c) data minimisation: the marker carries a
 * SHA-256 hex prefix of `attendee_email_lower`, NOT the raw email.
 * Audit payload `attendeeEmailHash` and `errorRows.reason` both read
 * from this field — neither surface is permitted to leak raw PII.
 */
class CancellationSkipMarker extends Error {
  readonly _csvSkipBrand = CANCELLATION_SKIP_BRAND;
  constructor(
    public readonly rowNumber: number,
    /** SHA-256 hex prefix (16 chars) of attendee_email_lower — PII-safe correlator. */
    public readonly emailHash: EmailHashPrefix,
  ) {
    super(`Cancellation skip marker (rowNumber=${rowNumber})`);
  }
}

function isCancellationSkip(e: unknown): e is CancellationSkipMarker {
  // `instanceof` already narrows `e` to CancellationSkipMarker — no
  // cast needed for the brand-equality check.
  return (
    e instanceof CancellationSkipMarker &&
    e._csvSkipBrand === CANCELLATION_SKIP_BRAND
  );
}

/**
 * Hash `attendee_email_lower` → SHA-256 hex prefix (16 chars). Used
 * for the cancellation-skip forensic correlator + state-change catch
 * logging. NEVER store the raw email in audit payloads or logs. The
 * branded return makes this the only legal source of `EmailHashPrefix`
 * values.
 */
function hashAttendeeEmail(email: string): EmailHashPrefix {
  return createHash('sha256')
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 16) as EmailHashPrefix;
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
       * receipt-duplicate row whose
       * `payment_status` (Status-derived) differed from the persisted
       * value AND was successfully UPDATEd to the new value. Counted
       * in `rowsStateChanged` (NOT `rowsAlreadyImported`); surfaced on
       * the `csv_import_completed` audit payload.
       */
      readonly kind: 'state_changed';
      readonly rowNumber: number;
      readonly previousPaymentStatus: import('../../domain/value-objects/payment-status').PaymentStatus;
      readonly newPaymentStatus: import('../../domain/value-objects/payment-status').PaymentStatus;
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
 * receipt-duplicate state-change detection.
 *
 * On re-upload, the idempotency receipt rowHash matches the first
 * upload's hash (event_external_id, email, registered_at) regardless
 * of payment_status. When the host flips Status in EventCreate between
 * runs (e.g., `Pending` → `Attending`), the receipt dedup catches the
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
/**
 * State-change probe result. Three terminal cases:
 *   - `'noop'`           — registration exists + state already matches the
 *                          incoming row → caller short-circuits with
 *                          `kind:'duplicate'`. Also used as the fallback
 *                          on `lookup_err`, `update_err`, `threw` so the
 *                          row is reported under `rowsAlreadyImported`
 *                          on the next re-upload retry.
 *   - `'orphan'`         — receipt exists in `eventcreate_idempotency_receipts`
 *                          but the matching `event_registrations` row was
 *                          deleted (manual cleanup / PII erasure / dev
 *                          teardown / pseudonymise sweep race). Caller
 *                          performs self-heal: delete the orphan receipt,
 *                          fall through to `processAttendeeInTx` so the
 *                          row inserts fresh, then re-insert the receipt
 *                          inside the same savepoint so future re-uploads
 *                          dedup correctly. Bug-fix 2026-05-18 — replaces
 *                          the previous ERROR-level "invariant violation"
 *                          fallback that silently counted the row as
 *                          `rowsAlreadyImported` (admin data loss).
 *   - `{kind:'state_changed', ...}` — registration exists + payment_status
 *                          differs → UPDATE applied, audit emitted; caller
 *                          returns this outcome verbatim.
 */
type StateChangeProbeResult =
  | { readonly kind: 'noop' }
  | { readonly kind: 'orphan' }
  | (RowOutcome & { readonly kind: 'state_changed' });

async function maybeApplyStateChange(
  parsed: ParsedOkRow,
  input: ImportCsvInput,
  ports: ImportCsvTxScopedPorts,
): Promise<StateChangeProbeResult> {
  // Skip refund transitions — handled by the intendedStateChange
  // Cancellation path which bypasses the receipt entirely.
  if (parsed.row.payment_status === 'refunded') return { kind: 'noop' };

  const repo = ports.registrationsRepo;

  try {
    const existing = await repo.findByEventAndEmail(
      input.tenantId,
      input.selectedEvent.eventId,
      parsed.row.attendee_email,
    );
    if (!existing.ok) {
      // Lookup err is a real signal (RLS denial, serialisation failure,
      // pool exhaustion). Log + metric so SRE sees the rate; row falls
      // back to duplicate so admin sees `rowsAlreadyImported` (next
      // re-upload retries).
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
      return { kind: 'noop' };
    }
    if (existing.value === null) {
      // Orphan receipt detected: the idempotency receipt is present
      // (tryInsert returned wasFresh=false) but no persisted
      // registration matches via (tenantId, eventId, email). Common
      // causes: registration deleted by admin PII erasure (F6 Phase 10
      // Wave 1), manual DB cleanup during dev/test, pseudonymise sweep
      // race, or events table cascade delete that didn't propagate to
      // receipts (no FK by design — request_id = rowHash, not
      // registration_id). Self-heal at the caller: delete the orphan
      // receipt + fall through to processAttendeeInTx so the row
      // inserts fresh. Bug-fix 2026-05-18 — replaces the previous
      // ERROR-level fallback that masked admin data loss as
      // `rowsAlreadyImported`. Logged at WARN, not ERROR, because the
      // self-heal recovers fully — SRE should see sustained rate > 0
      // but it is not an incident.
      logger.warn(
        {
          event: 'f6_csv_orphan_receipt_detected',
          tenantId: input.tenantId,
          rowNumber: parsed.rowNumber,
          eventId: input.selectedEvent.eventId,
          rowHash: parsed.rowHash,
        },
        '[F6.1] orphan receipt detected — registration absent; caller will self-heal',
      );
      return { kind: 'orphan' };
    }
    const persisted = existing.value;
    if (persisted.ticket.paymentStatus === parsed.row.payment_status) {
      return { kind: 'noop' };
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
        '[F6.1] state-change UPDATE err — admin Status-flip silently dropped; falls back to duplicate',
      );
      eventcreateMetrics.csvImportStateChangeFallback(
        input.tenantId,
        'update_err',
      );
      return { kind: 'noop' };
    }
    // Emit per-row state-change audit. PDPA Art. 30 + GDPR Art. 30
    // require traceable processing-records for payment-status
    // mutations of an existing PII row. In-tx emit (via the
    // savepoint-scoped audit port) so audit + UPDATE either both
    // commit or both roll back atomically.
    // Wrap audit.emit in its own try/catch so a RAW throw (e.g., the
    // tx handle already aborted upstream, or a Drizzle serialisation
    // failure) is converted to TxStageError. Otherwise the outer
    // `instanceof TxStageError` check below would miss it and fall
    // through to the silent "treat row as duplicate" path — a PDPA
    // Art. 30 / GDPR Art. 30 processing-records gap.
    let auditResult: Awaited<ReturnType<typeof ports.audit.emit>>;
    try {
      auditResult = await ports.audit.emit({
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
    } catch (rawThrow) {
      // H8.1 + R4-I2 — thread the raw exception via Error.cause so
      // SRE forensics see the underlying error class (PostgresError,
      // AbortError, etc.) in addition to the message + failureStage.
      // R4-I2 (2026-05-18) — symmetric with `emitOrThrow` raw-throw
      // wrap: non-Error throws get a synthetic Error via `safeStringify`
      // so plain-object throws (`{kind:'POOL_EXHAUSTED',...}`)
      // preserve diagnostic content instead of collapsing to
      // `[object Object]`.
      const causeErr =
        rawThrow instanceof Error
          ? rawThrow
          : new Error(`NonError(${safeStringify(rawThrow)})`);
      throw new TxStageError(
        'audit_emit',
        `csv_import_row_state_changed audit emit threw: ${causeErr.message}`,
        { cause: causeErr },
      );
    }
    if (!auditResult.ok) {
      // State-change audit failure: roll back the savepoint by
      // throwing — PDPA Art. 30 / GDPR Art. 30 processing-records
      // require the payment_status UPDATE be forensically traceable
      // (see `audit-port.ts § csv_import_row_state_changed`). The
      // outer catch converts to `kind:'row_failed'` so admin sees
      // the failure clearly. The outer catch detects this TxStageError
      // and re-throws so the savepoint actually rolls back.
      throw new TxStageError(
        'audit_emit',
        `csv_import_row_state_changed audit emit failed: ${auditResult.error.kind}`,
      );
    }

    // Option B+ (2026-05-18) /speckit-review follow-up — quota credit /
    // debit on a state-change that crosses the counted/uncounted boundary.
    // The fresh-insert path in `processAttendeeInTx` calls
    // `applyQuotaEffect` for new rows; the state-change path historically
    // updated `payment_status` only — leaving `counted_against_*` flags
    // stale on re-uploads that flipped Pending → Attending (or vice
    // versa). Strict-correctness invariant: either the row flips AND
    // the quota reflects the new state, or neither (savepoint rolls back).
    const matchedMemberId = persisted.match.matchedMemberId;
    // R2-3 (2026-05-18) — quota-counting rule extracted to
    // `isQuotaCountedStatus` Domain VO predicate so the rule cannot
    // drift between `applyQuotaEffect` (fresh-insert path) and this
    // state-change probe.
    const oldCounted = isQuotaCountedStatus(persisted.ticket.paymentStatus);
    const newCounted = isQuotaCountedStatus(parsed.row.payment_status);
    if (oldCounted !== newCounted && matchedMemberId !== null) {
      // Load event flags to gate the quota call (no quota effect on
      // non-partnership / non-cultural / archived events).
      const eventLookup = await ports.eventsRepo.findById(
        input.tenantId,
        input.selectedEvent.eventId,
      );
      if (!eventLookup.ok) {
        // R2-7 (2026-05-18 /speckit-review Round 2) — split DB-read
        // error from the legitimate "non-eligible event" branch. Pre-R2
        // both paths folded into a silent fall-through which masked
        // transient DB errors. With the explicit WARN + dedicated
        // metric, SRE can alert when the state-change path silently
        // skips quota for a *real* lookup failure (which may matter if
        // the event was actually quota-eligible). Fail-safe: still skip
        // the quota call so we don't synthesize credit/debit on
        // partial DB state.
        logger.warn(
          {
            event: 'f6_csv_state_change_event_lookup_err',
            tenantId: input.tenantId,
            eventId: input.selectedEvent.eventId,
            rowNumber: parsed.rowNumber,
            err: eventLookup.error.kind,
          },
          '[F6.1] event lookup failed during state-change quota gate — treating as non-eligible',
        );
        eventcreateMetrics.csvImportEventLookupFailed(
          input.tenantId,
          'state_change_quota_gate',
        );
      } else if (
        eventLookup.value !== null &&
        eventLookup.value.archivedAt === null &&
        (eventLookup.value.isPartnerBenefit ||
          eventLookup.value.isCulturalEvent)
      ) {
        const event = eventLookup.value;
        const fiscalYear = deriveFiscalYear(
          event.startDate.toISOString(),
          F6_FISCAL_YEAR_START_MONTH,
        );
        if (!oldCounted && newCounted) {
          // Credit path — pending/waitlisted/no_show → paid/free.
          // Delegates to the same `applyQuotaEffect` used by the
          // fresh-insert pipeline; the quota_*_decremented audit
          // emits inside that call.
          const q = await applyQuotaEffect(
            {
              tenantId: input.tenantId,
              matchedMemberId,
              eventId: event.eventId,
              registrationId: persisted.registrationId,
              eventFlags: {
                isPartnerBenefit: event.isPartnerBenefit,
                isCulturalEvent: event.isCulturalEvent,
              },
              fiscalYear,
              paymentStatus: parsed.row.payment_status,
              actorType: 'csv_import',
              actorUserId: input.actorUserId,
              occurredAt: new Date(),
            },
            {
              quotaAccountingPort: ports.quotaAccountingPort,
              advisoryLockAcquirer: ports.advisoryLockAcquirer,
              audit: ports.audit,
            },
          );
          if (!q.ok) {
            throw new TxStageError(
              'quota_decrement',
              `state-change quota credit failed (${q.error.kind})`,
            );
          }
          const decided = q.value.quotaEffect;
          if (
            decided.countedAgainstPartnership ||
            decided.countedAgainstCulturalQuota
          ) {
            const setRes = await ports.registrationsRepo.setQuotaEffect(
              input.tenantId,
              persisted.registrationId,
              decided,
            );
            if (!setRes.ok) {
              throw new TxStageError(
                'quota_decrement',
                `state-change setQuotaEffect failed: ${setRes.error.kind}`,
              );
            }
          }
        } else {
          // Debit path — paid/free → pending/waitlisted/no_show.
          // Rare in practice (host un-verifies payment) but the
          // symmetric correctness keeps `counted_against_*` flags in
          // sync with `payment_status`. Pattern mirrors the FR-018
          // refund branch in process-attendee-in-tx.ts (search for
          // `markRefunded`).
          const prev = persisted.quotaEffect;
          if (
            prev.countedAgainstPartnership ||
            prev.countedAgainstCulturalQuota
          ) {
            // R2-1b (2026-05-18 /speckit-review Round 2 Blocker) —
            // serialize the (tenant, member, event) write window before
            // the clear + audit emit. Credit path locks via
            // `apply-quota-effect.ts` (see the `acquire()` call before
            // `queryAllotments`); debit path was racing pre-R2.
            // Mirrors the FR-018 refund-branch advisory-lock pattern in
            // `process-attendee-in-tx.ts` (search for `buildQuotaLockKey`).
            try {
              await ports.advisoryLockAcquirer.acquire(
                buildQuotaLockKey(
                  input.tenantId,
                  matchedMemberId,
                  event.eventId,
                ),
              );
            } catch (e) {
              const causeErr =
                e instanceof Error
                  ? e
                  : new Error(`NonError(${String(e)})`);
              throw new TxStageError(
                'quota_decrement',
                `state-change debit advisory-lock acquisition failed: ${causeErr.message}`,
                { cause: causeErr },
              );
            }
            // R2-1 fault-injection — test-only seam for the savepoint
            // rollback regression in
            // `tests/integration/events/csv-state-change-quota-rollback.test.ts`.
            // Fires AFTER the debit advisory-lock acquires (lock is
            // held when throw fires → savepoint rolls back → lock
            // auto-released at tx end). Guarded by `NODE_ENV==='test'`
            // so production deploys (`NODE_ENV='production'`) short-
            // circuit the boolean and pay zero cost. Precedent:
            // D1/D2 at lines 1080-1095 below.
            if (
              process.env.NODE_ENV === 'test' &&
              process.env.F6_TEST_FAIL_AT_QUOTA_DEBIT === 'true'
            ) {
              throw new TxStageError(
                'quota_decrement',
                'TEST-INJECTED — fail at state-change debit (R2-1)',
              );
            }
            const clearRes = await ports.registrationsRepo.setQuotaEffect(
              input.tenantId,
              persisted.registrationId,
              {
                countedAgainstPartnership: false,
                countedAgainstCulturalQuota: false,
              },
            );
            if (!clearRes.ok) {
              throw new TxStageError(
                'quota_decrement',
                `state-change clear quota failed: ${clearRes.error.kind}`,
              );
            }
            // Query allotment snapshot AFTER the flag-clear so the
            // `allotmentAfter` payload reflects post-debit state —
            // identical to the FR-018 refund snapshot semantics.
            const snap = await ports.quotaAccountingPort.queryAllotments({
              tenantId: input.tenantId,
              memberId: matchedMemberId,
              eventId: event.eventId,
              fiscalYear,
            });
            if (!snap.ok) {
              throw new TxStageError(
                'quota_decrement',
                `state-change allotment snapshot failed (${snap.error.kind})`,
              );
            }
            // R2-3 (2026-05-18) — emit shape folded through
            // `emitCreditBackViaStateChange` helper so the partnership
            // + cultural branches cannot drift apart.
            if (prev.countedAgainstPartnership) {
              await emitCreditBackViaStateChange(ports.audit, {
                tenantId: input.tenantId,
                actorUserId: input.actorUserId,
                rowNumber: parsed.rowNumber,
                registrationId: persisted.registrationId,
                memberId: matchedMemberId,
                previousPaymentStatus: update.value.previousPaymentStatus,
                newPaymentStatus: parsed.row.payment_status,
                scope: 'partnership',
                allotmentAfter:
                  snap.value.allotments.partnershipPerEvent -
                  snap.value.consumed.partnershipConsumedForEvent,
              });
            }
            if (prev.countedAgainstCulturalQuota) {
              await emitCreditBackViaStateChange(ports.audit, {
                tenantId: input.tenantId,
                actorUserId: input.actorUserId,
                rowNumber: parsed.rowNumber,
                registrationId: persisted.registrationId,
                memberId: matchedMemberId,
                previousPaymentStatus: update.value.previousPaymentStatus,
                newPaymentStatus: parsed.row.payment_status,
                scope: 'cultural',
                allotmentAfter:
                  snap.value.allotments.culturalPerYear -
                  snap.value.consumed.culturalConsumedForYear,
              });
            }
          }
        }
      }
      // else: no quota effect — non-benefit event, archived, or
      // eventLookup.value === null (event was deleted between matching
      // and quota gate). The DB-read-error case is split into its own
      // branch above (R2-7). The payment_status UPDATE still committed
      // — correct, as it always mirrors upstream Status.
    }

    return {
      kind: 'state_changed' as const,
      rowNumber: parsed.rowNumber,
      previousPaymentStatus: update.value.previousPaymentStatus,
      newPaymentStatus: parsed.row.payment_status,
    };
  } catch (e) {
    // R2-1 (2026-05-18 /speckit-review Round 2 Blocker) — every
    // TxStageError stage MUST re-throw so the SAVEPOINT rolls back
    // atomically. Pre-R2 only `'audit_emit'` was re-thrown, leaving
    // `'quota_decrement'` / `'event_upsert'` / `'idempotency_receipt'` /
    // `'registration_insert'` to silently swallow via
    // `return { kind: 'noop' }`. The swallow committed the
    // payment_status UPDATE in-savepoint while quota flags + state-
    // change audit either never ran or rolled back inconsistently —
    // directly contradicting the block-comment invariant at lines
    // 660-667 ("strict-correctness invariant: either the row flips AND
    // the quota reflects the new state, or neither").
    if (e instanceof TxStageError) {
      // Audit-emit failure has a DEDICATED counter
      // (`csvImportAuditEmitFailed`) so SRE alerts on this class
      // separately from the rollback-cause counter. The two metric
      // series stay disjoint — `csvImportStateChangeFallback` is a
      // pure "rollback cause" signal; audit-emit failures land on
      // `csvImportAuditEmitFailed`.
      if (e.stage === 'audit_emit') {
        eventcreateMetrics.csvImportAuditEmitFailed(
          input.tenantId,
          'csv_import_row_state_changed',
        );
      } else {
        eventcreateMetrics.csvImportStateChangeFallback(
          input.tenantId,
          e.stage,
        );
      }
      logger.error(
        {
          event: 'f6_csv_state_change_savepoint_rollback',
          tenantId: input.tenantId,
          rowNumber: parsed.rowNumber,
          stage: e.stage,
          attendeeEmailHash: hashAttendeeEmail(parsed.row.attendee_email),
          err: toErrMessage(e),
        },
        '[F6.1] state-change probe TxStageError — savepoint rolls back atomically',
      );
      throw e; // propagate to outer SAVEPOINT for rollback
    }
    // Non-TxStageError (programmer/runtime defect) — log + bounded
    // metric + return noop. This path shouldn't fire in practice; the
    // 'unknown' bucket exists so cardinality stays bounded under any
    // future runtime regressions.
    logger.error(
      {
        event: 'f6_csv_state_change_threw',
        tenantId: input.tenantId,
        rowNumber: parsed.rowNumber,
        attendeeEmailHash: hashAttendeeEmail(parsed.row.attendee_email),
        err: toErrMessage(e),
      },
      '[F6.1] state-change probe threw — non-TxStageError fallback; admin re-upload required',
    );
    eventcreateMetrics.csvImportStateChangeFallback(input.tenantId, 'unknown');
    return { kind: 'noop' };
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
      // Cancellation rows BYPASS the receipt
      // entirely: a previous Attending row for the same attendee shares
      // the same rowHash (the canonical key omits payment_status), so the
      // receipt would dedupe the cancel re-upload. Bypassing routes the
      // row straight into `processAttendeeInTx` so the FR-018 refund
      // branch can flip an existing paid row + emit the credit-back
      // audit. First-time Cancellation rows (no prior registration) land
      // as a refunded ghost row — harmless side effect: no quota effect,
      // no audit emit (matchedMember+counted gates remain in effect).
      //
      // Orphan-recovery flag (bug-fix 2026-05-18): when the state-change
      // probe finds a receipt-duplicate but no persisted registration,
      // we delete the orphan receipt here, fall through to
      // `processAttendeeInTx` so the row inserts fresh, and re-insert
      // the receipt at the end of the savepoint so future re-uploads
      // dedup correctly. If `processAttendeeInTx` throws, the savepoint
      // rolls back including the delete + (absent) re-insert — the
      // original orphan state is restored, safe to retry.
      let orphanRecovery = false;
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
          // from the persisted row (e.g. admin re-uploaded after the host
          // flipped Status in EventCreate), apply a state-change UPDATE
          // before returning.
          // Refund transitions go through markRefunded + the FR-018
          // credit-back path; non-refund payment_status changes go
          // through updatePaymentStatus (no quota effect).
          const stateChange = await maybeApplyStateChange(
            parsed,
            input,
            ports,
          );
          if (stateChange.kind === 'state_changed') return stateChange;
          if (stateChange.kind === 'noop') {
            return { kind: 'duplicate' as const, rowNumber: parsed.rowNumber };
          }
          // stateChange.kind === 'orphan' — registration was deleted
          // out-of-band. Self-heal: delete the orphan receipt and let
          // control fall through to processAttendeeInTx below. The
          // receipt gets re-inserted after processAttendeeInTx commits
          // inside this same savepoint (line below the
          // processAttendeeInTx call), so the final state mirrors a
          // fresh first-time upload + correct future-dedup semantics.
          const del = await ports.idempotencyStore.delete({
            tenantId: input.tenantId,
            source: 'eventcreate_csv',
            requestId: parsed.rowHash,
          });
          if (!del.ok) {
            throw new TxStageError(
              'idempotency_receipt',
              `orphan receipt delete failed: ${del.error.message}`,
            );
          }
          // R2-7 (2026-05-18 /speckit-review Round 2) — the
          // `csvImportOrphanReceiptRecovered` metric used to fire here,
          // BEFORE `processAttendeeInTx` ran. If the savepoint
          // subsequently rolled back, the recovery counter was already
          // incremented — over-counting failed recoveries. Moved to the
          // end of the savepoint (after the receipt re-insert succeeds)
          // so the metric reflects only committed recoveries.
          orphanRecovery = true;
          // D1 fault-injection — test-only seam for the savepoint
          // rollback regression in
          // `tests/integration/events/csv-orphan-receipt-self-heal.test.ts`.
          // Fires AFTER the orphan-delete commits in-savepoint but
          // BEFORE processAttendeeInTx runs. Forces the savepoint to
          // roll back the delete so the receipt is restored. Guarded
          // by `NODE_ENV==='test'` so production deploys
          // (`NODE_ENV='production'`) short-circuit the boolean and
          // pay zero cost. Precedent: `deterministic-render.ts:215`.
          if (
            process.env.NODE_ENV === 'test' &&
            process.env.F6_TEST_FAIL_AFTER_ORPHAN_DELETE === 'true'
          ) {
            throw new TxStageError(
              'event_upsert',
              'TEST-INJECTED — fail after orphan-receipt delete (D1)',
            );
          }
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

      // first-time Cancellation has no prior
      // registration to refund. Roll back the savepoint (undo the
      // refunded ghost row that `insertOnConflictDoNothing` just
      // created) by raising the marker error; the outer catch maps it
      // to `kind:'skipped'` so the row flows into `rowsSkipped` (NOT
      // `rowsFailed` / `rowsProcessed`). Audit-quiet: no
      // `csv_import_row_failed` emit.
      if (parsed.intendedStateChange && result.isNewRegistration) {
        // Hash at the throw site so neither the audit payload nor the
        // errorRows reason can ever surface the raw email (PDPA Art. 5(1)(c)).
        throw new CancellationSkipMarker(
          parsed.rowNumber,
          hashAttendeeEmail(parsed.row.attendee_email),
        );
      }

      // Orphan-recovery self-heal: if we deleted an orphan receipt
      // above to let this row insert fresh, re-insert the receipt now
      // so future re-uploads dedup correctly.
      //
      // Ordering invariant: the re-insert MUST sit AFTER the
      // `processAttendeeInTx` call above — if it ran BEFORE, the in-tx
      // `processAttendeeInTx` could itself observe the fresh receipt
      // and bail with a duplicate outcome, breaking the recovery.
      //
      // Concurrent-self-heal race: we deliberately do NOT check
      // `reinsert.value.wasFresh`. If another worker / re-upload
      // happened to insert the same receipt between our delete and
      // re-insert, both transactions converge to the same persisted
      // state (one registration + one receipt) under the per-(tenant,
      // event) advisory lock in the outer batch tx, so observing
      // `wasFresh:false` here is benign — not a bug.
      //
      // Same savepoint scope — if anything else throws after this,
      // the re-insert rolls back atomically.
      if (orphanRecovery) {
        // D2 fault-injection — test-only seam for the savepoint
        // rollback regression. Fires AT the post-processAttendeeInTx
        // receipt re-insert site. Forces the savepoint to roll back
        // BOTH the registration insert AND the orphan-delete so the
        // pre-savepoint state is fully restored. Same NODE_ENV guard
        // as D1.
        if (
          process.env.NODE_ENV === 'test' &&
          process.env.F6_TEST_FAIL_AT_RECEIPT_REINSERT === 'true'
        ) {
          throw new TxStageError(
            'idempotency_receipt',
            'TEST-INJECTED — fail at receipt re-insert (D2)',
          );
        }
        const reinsert = await ports.idempotencyStore.tryInsert({
          tenantId: input.tenantId,
          source: 'eventcreate_csv',
          requestId: parsed.rowHash,
        });
        if (!reinsert.ok) {
          throw new TxStageError(
            'idempotency_receipt',
            `orphan-recovery receipt re-insert failed: ${reinsert.error.message}`,
          );
        }
        // R2-7 (2026-05-18) — emit recovery counter AFTER the full
        // orphan-recovery sequence (delete + processAttendeeInTx +
        // receipt re-insert) commits in-savepoint. If any prior step
        // threw, the savepoint rolled back and this line was never
        // reached, so the metric stays at zero — correct semantics.
        eventcreateMetrics.csvImportOrphanReceiptRecovered(input.tenantId);
      }

      // Bug-fix 2026-05-18 — `processAttendeeInTx` upserts via ON
      // CONFLICT DO UPDATE on (tenant_id, event_id, external_id). If
      // the unique-index conflict fires, `isNewRegistration=false` —
      // the registration was already in the DB. This happens when a
      // re-upload uses a NEW rowHash format (computeRowHash changed
      // to include attendee_external_id) but the registration was
      // already persisted under the OLD hash form on a prior upload.
      // Without this branch, the row would be reported as
      // `kind:'inserted'` even though nothing was actually inserted —
      // the user-visible summary would show "rows imported: 17" on a
      // re-upload that touched zero rows. Report as `duplicate` so the
      // summary's rowsProcessed reflects only genuinely-new rows.
      //
      // Intentional side-effect omission (silent-failure-hunter R2-W2,
      // 2026-05-18 follow-up): this branch deliberately does NOT
      // accumulate `summary.matchCounts[outcome.matchType]` nor
      // `summary.eventsUpdated`. Those counters track "how many NEW
      // rows did THIS upload produce" — and on a no-op upsert, nothing
      // new was produced. The underlying `attendee_matched_*` audit
      // DID fire inside `processAttendeeInTx` regardless, so
      // audit-log forensics remain complete. The summary intentionally
      // diverges from audit cardinality on duplicates.
      if (!result.isNewRegistration) {
        return { kind: 'duplicate' as const, rowNumber: parsed.rowNumber };
      }

      return {
        kind: 'inserted' as const,
        rowNumber: parsed.rowNumber,
        matchType: result.matchType,
        eventCreated: result.eventCreated,
      };
    });
  } catch (e) {
    // first-time Cancellation (no prior
    // registration). Savepoint rolled back; surface as a `skipped`
    // outcome so the row flows into `rowsSkipped` instead of
    // `rowsFailed`.
    if (isCancellationSkip(e)) {
      // Emit low-severity forensic event so support can reconstruct
      // WHY this row appears in `rowsSkipped`. Audit emit failure is
      // non-blocking (informational forensics, not a strict-audit
      // surface). `e.emailHash` is the SHA-256 prefix (16 hex chars);
      // both audit payload + errorRows.reason consume the hash only.
      await safeEmitCancellationNoPrior(deps, input, e.rowNumber, e.emailHash);
      return {
        kind: 'skipped',
        rowNumber: e.rowNumber,
        reason: `Skipped: Status=Cancelled without prior registration (emailHash=${e.emailHash}, no-op)`,
      };
    }
    // Savepoint rolled back; outer tx + other rows preserved. Preserve
    // `TxStageError.stage` taxonomy on BOTH the `RowOutcome.row_failed`
    // field AND the `csv_import_row_failed` audit payload so dashboards
    // can alert on `audit_emit` failures (security-critical).
    const reason = toErrMessage(e);
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
      // R6.W / Round 5 staff-review R017 closure — `batchConcurrency=3`
      // in the input docs implies parallelism that does NOT materialise
      // for same-event imports. Effective concurrency = 1 within an
      // import; parallelism is preserved only ACROSS imports targeting
      // DIFFERENT events. If F6.2 needs intra-import parallelism (e.g.
      // 10k-row uploads), the lock would need to split to per-(tenant,
      // event, batch) — but that requires careful deadlock-avoidance
      // ordering across the batch range.
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
    const reason = toErrMessage(e);
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
    // errors, but we still inspect `Promise.allSettled` results so a
    // future refactor that removes the internal swallow doesn't drop
    // signal silently (silent-failure I-8 close).
    // Skip emit when a row already emitted via its savepoint catch —
    // otherwise SRE dashboards over-count and forensic reviewers see
    // contradictory failureStage narratives for the same rowNumber.
    const fanOutResults = await Promise.allSettled(
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
    for (const r of fanOutResults) {
      if (r.status === 'rejected') {
        logger.error(
          {
            event: 'f6_csv_batch_fan_out_rejected',
            tenantId: input.tenantId,
            err: toErrMessage(r.reason),
          },
          '[F6] batch-tx-abort fan-out emit rejected — internal swallow regressed; forensic trail at risk',
        );
      }
    }
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
 * R5.4 / Round 4 I-8 — delegates to the shared `formatErrorWithCause`
 * helper. Previously inlined the same cause-appending logic that
 * `ingest-webhook-attendee.ts:384` also inlined; consolidated to one
 * source of truth so future stack-capture + PII-redaction extensions
 * land in one place.
 */
function toErrMessage(e: unknown): string {
  return formatErrorWithCause(e);
}

/**
 * Record an audit-emit failure (Result.err OR thrown exception) into
 * the dedicated csvImportAuditEmitFailed counter + a structured
 * logger.error so SREs alert on rate>0 without losing forensic context.
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
  // Each call-site MUST include `actorUserId` in the context so
  // forensics can attribute the audit-emit failure to the triggering
  // admin. Convention-only — the `Readonly<Record<string, unknown>>`
  // type does NOT enforce it. (If the call-site count is later
  // bounded, switch to a discriminated union to lift this to a
  // compile error.)
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
        err: toErrMessage(e),
      },
    );
  }
}

/**
/**
 * Emit a low-severity forensic event when a first-time Cancellation
 * row is skipped. Audit-quiet on emit failure (informational only,
 * not a strict-audit-invariant surface).
 */
async function safeEmitCancellationNoPrior(
  deps: ImportCsvDeps,
  input: ImportCsvInput,
  rowNumber: number,
  // Branded type so the caller cannot accidentally pass a raw email.
  // Only `hashAttendeeEmail` returns `EmailHashPrefix`; TypeScript
  // compile-time check at the call site.
  emailHash: EmailHashPrefix,
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
        {
          actorUserId: input.actorUserId,
          rowNumber,
          auditErrKind: result.error.kind,
        },
      );
    }
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_row_cancelled_no_prior',
      'f6_csv_row_cancelled_no_prior_audit_emit_threw',
      '[F6.1] csv_import_row_cancelled_no_prior audit emitter threw — forensic trail loss (informational)',
      {
        actorUserId: input.actorUserId,
        rowNumber,
        err: toErrMessage(e),
      },
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
  // The `parseStreamWithFormat` method detects EventCreate vs
  // generic format from the header, translates EventCreate rows via
  // the T010 adapter, and merges `selectedEvent` into every row.
  const eventContext = {
    externalId: input.selectedEvent.externalId,
    name: input.selectedEvent.name,
    startDate: input.selectedEvent.startDate,
    category: input.selectedEvent.category,
  };

  // Port method is required; Phase 7 mocks provide it via
  // `wrapParseStreamAsFormat` helper.
  let parsed: Awaited<ReturnType<CsvImporter['parseStreamWithFormat']>>;
  try {
    parsed = await deps.csvImporter.parseStreamWithFormat({
      bytes: input.bytes,
      eventContext,
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
      // pass through `adapterEnabled` from composition. The
      // importer treats `undefined` as `true` (normal detection).
      ...(input.adapterEnabled !== undefined && {
        adapterEnabled: input.adapterEnabled,
      }),
    });
  } catch (e) {
    // Structured log capture of the raw message + stack to stderr;
    // admin-facing message is generic to prevent internal-details leak
    // (e.g., Drizzle "relation does not exist" or Postgres
    // connection-string fragments).
    logger.error(
      {
        event: 'f6_csv_parser_threw',
        tenantId: input.tenantId,
        recordId,
        err: toErrMessage(e),
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

  // Emit the rollback-trigger signal
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
      // Sanitize unknown column names so a CRLF-injection or oversized
      // header can't pollute the log stream. Cap each name to 64 chars
      // + strip control chars.
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
      // Pino transport failure must not abort the import.
      // Observability degraded; correctness preserved.
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
  // R6.W / Round 5 staff-review R009 closure — propagate safety-net
  // fail-open state to the response so the admin UX can surface a
  // "safety-net unavailable" warning chip. Previously the fail-open
  // path was silent: SRE saw the metric but the admin had no UX cue
  // that the FR-019b duplicate-protection didn't run.
  let safetyNetFailedOpen = false;
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
        // Elevated to logger.error per Phase B B13 — FR-019b duplicate
        // protection has been silently disabled for this upload; SRE
        // must see the rate on the dashboard. Outage of the safety-net
        // query is a defence-in-depth gap, not a routine occurrence.
        logger.error(
          {
            event: 'f6_csv_safety_net_query_failed',
            tenantId: input.tenantId,
            fingerprint: attendeeFingerprint,
            eventId: input.selectedEvent.eventId,
            eventExternalId: input.selectedEvent.externalId,
            err: result.error.kind,
          },
          '[F6.1] safety-net fingerprint query failed — proceeding without warning (fail-open; FR-019b protection disabled for this upload)',
        );
        eventcreateMetrics.csvImportSafetyNetFallback(
          input.tenantId,
          'result_err',
        );
        safetyNetFailedOpen = true; // R6.W / R009 — surface to admin UX
      }
    } catch (e) {
      logger.error(
        {
          event: 'f6_csv_safety_net_query_threw',
          tenantId: input.tenantId,
          eventId: input.selectedEvent.eventId,
          eventExternalId: input.selectedEvent.externalId,
          err: toErrMessage(e),
        },
        '[F6.1] safety-net fingerprint query threw — fail-open; FR-019b duplicate protection disabled for this upload',
      );
      eventcreateMetrics.csvImportSafetyNetFallback(input.tenantId, 'threw');
      safetyNetFailedOpen = true; // R6.W / R009 — surface to admin UX
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
  // Strict-audit invariant. If the override audit emit fails, REFUSE
  // to proceed with the import — a forceProceed import without a
  // forensic trail breaks the FR-019c contract. Admin retries via the
  // same form; the audit store may have recovered by then.
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
        err: toErrMessage(e),
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
            // receipt-duplicate that triggered an UPDATE of
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
        // Elevate to error + emit metric. The error rows are lost from
        // the US5 download surface for this import (admin must re-run);
        // SRE alerts on `rate > 0`.
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
        eventcreateMetrics.csvErrorCsvUploadFailed(
          input.tenantId,
          'result_err',
        );
      }
    } catch (e) {
      logger.error(
        {
          event: 'f6_csv_error_csv_blob_put_threw',
          tenantId: input.tenantId,
          recordId,
          err: toErrMessage(e),
        },
        '[F6.1] error-CSV blob put THREW — US5 download unavailable; investigate Vercel Blob outage',
      );
      eventcreateMetrics.csvErrorCsvUploadFailed(input.tenantId, 'threw');
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
          // Staff-review H-1: persist the re-upload state-change
          // counter so the import-history row reflects whether the
          // re-upload was a no-op (zero state-changes) or carried
          // meaningful mutations.
          rowsStateChanged: summary.rowsStateChanged,
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
                rowsStateChanged: summary.rowsStateChanged,
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
              err: toErrMessage(recoveryErr),
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
          '[F6.1] csv_import_records final-outcome update failed — placeholder row persists as running (stale; expected terminal outcome was never written back)',
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
        err: toErrMessage(e),
      },
      '[F6.1] csv_import_records final-outcome update threw',
    );
  }
  // F6.1 — Phase 4e: emit per-import `csv_import_completed` audit on
  // both completed AND timeout paths with `sourceFormat` extension.
  // Capture audit-completion emit success so the outcome can surface
  // the audit-trail gap to the UI (degraded chip).
  const auditCompletionEmitted = await emitImportCompletedAudit({
    deps,
    input,
    summary: {
      rowsProcessed: summary.rowsProcessed,
      rowsAlreadyImported: summary.rowsAlreadyImported,
      rowsStateChanged: summary.rowsStateChanged,
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
      // Partial summary surfaced so admins + route handler aren't
      // blind to which rows committed.
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
      auditCompletionEmitted,
      safetyNetFailedOpen,
    };
  }

  return {
    kind: 'completed',
    recordId,
    sourceFormat,
    errorCsvAvailable,
    historyPersisted,
    auditCompletionEmitted,
    safetyNetFailedOpen,
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
    const reason = csvEscape(sanitiseFormulaPrefix(row.reason));
    const stage = csvEscape(sanitiseFormulaPrefix(row.failureStage ?? ''));
    lines.push(`${row.rowNumber},${reason},${stage}`);
  }
  const text = lines.join('\r\n') + '\r\n';
  return new TextEncoder().encode(text);
}

/**
 * R6.W / Round 5 staff-review R012 (T-06) closure — CSV formula
 * injection guard. When an admin opens the error-CSV in Excel/Sheets,
 * cells starting with `=`, `+`, `-`, `@` auto-evaluate as formulas. If
 * a row-rejection `reason` string ever surfaces user-supplied content
 * starting with those characters, the formula executes on download.
 *
 * Mitigation: prepend a single-quote literal so the cell renders as
 * text. OWASP CSV-Injection-recommended pattern.
 *
 * `reason` strings today are server-generated (failureStage + repo
 * error class) so this is defense-in-depth, but a future feature that
 * surfaces user input (e.g. raw row excerpt) would route through here.
 */
function sanitiseFormulaPrefix(s: string): string {
  if (s.length === 0) return s;
  const first = s.charAt(0);
  // R7.S / Staff R2 R044 closure — extended guard chars: `\t` and
  // `\r` are LibreOffice Calc formula triggers per OWASP CSV-Injection
  // cheatsheet. Today benign (server-generated `reason` strings don't
  // start with whitespace) but defense-in-depth for when user-input
  // surfaces are added (e.g., `rawRowExcerpt` in a future feature).
  //
  // R8.S / Staff R3 R068 (Suggestion) — sanitiser does NOT cover
  // `\0` (NULL byte) or Unicode fullwidth `＝` (U+FF1D) / `＋`
  // (U+FF0B) / `－` (U+FF0D) / `＠` (U+FF20). OWASP cheatsheet focuses
  // on 6 ASCII chars. Theoretical risk today (server-generated strings
  // don't contain these). A future feature surfacing user-input cell
  // values must add Unicode normalisation + fullwidth char detection
  // here. Tracked as F6.1 backlog item; non-blocking.
  //
  // R8.S / Staff R3 R063 — `\r` interaction with `csvEscape` below:
  // when `\r` survives this gate (untouched by sanitiser if NOT first
  // char) it passes through `csvEscape` which double-quote-wraps the
  // cell. The resulting `"...\r..."` renders as:
  //   - Excel: line-break inside the cell (RFC-4180 standard).
  //   - LibreOffice Calc: literal `\r` glyph in the cell.
  // This is RFC-4180-valid but visually ambiguous. Acceptable today
  // because server-generated `reason` / `failureStage` strings do not
  // contain `\r`. A future feature surfacing user-input cell values
  // (e.g., `rawRowExcerpt`) should consider stripping `\r` before
  // sanitisation OR documenting the ambiguity in admin-facing docs.
  if (
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@' ||
    first === '\t' ||
    first === '\r'
  ) {
    return `'${s}`;
  }
  return s;
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
 * Strict-audit invariant: when the audit emit fails OR throws,
 * return `false` so the caller can REFUSE to proceed with the import.
 * A forceProceed without a forensic trail breaks the FR-019c contract;
 * admin retry may succeed against the same DB.
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
        err: toErrMessage(e),
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
    /**
     * Staff-review H-1: subset of rowsProcessed whose
     * state actually changed on this re-upload (Status-driven payment
     * flip, e.g. Pending → Attending or Attending → Cancelled). Surfaced on the audit payload
     * so post-import forensic queries can distinguish no-op re-uploads
     * from re-uploads that mutated existing registrations.
     */
    readonly rowsStateChanged: number;
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
): Promise<boolean> {
  // Returns true on successful emit, false on Result.err OR throw.
  // Caller threads into the outcome so the UI can degrade the audit-
  // trail chip when forensic record is lost.
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
        // Staff-review H-1: re-upload state-change counter on the
        // forensic audit payload.
        rowsStateChanged: summary.rowsStateChanged,
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
        {
          actorUserId: input.actorUserId,
          ...completedAuditContext,
          auditErrKind: result.error.kind,
        },
      );
      return false;
    }
    return true;
  } catch (e) {
    recordAuditEmitFailure(
      input.tenantId,
      'csv_import_completed',
      'f6_csv_import_completed_audit_emit_threw',
      '[F6] csv_import_completed audit emitter threw — entire-import forensic record lost',
      {
        actorUserId: input.actorUserId,
        ...completedAuditContext,
        err: toErrMessage(e),
      },
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test-only internals
// ---------------------------------------------------------------------------
//
// Exported under `_internals` to mark "test-seam only — not for
// production consumers" (precedent: streaming-csv-importer.ts). Enables
// collision-resistance unit tests for the Symbol-brand pattern without
// weakening the production API surface.

export const _internals = {
  CancellationSkipMarker,
  isCancellationSkip,
  hashAttendeeEmail,
  // R8.W / Staff R3 R056 — exported for direct unit-test coverage of the
  // OWASP CSV-Injection sanitiser. Production callers continue to invoke
  // the file-private function inside `serialiseErrorCsv`; this re-export
  // serves test-only consumers in
  // `tests/unit/events/import-csv-sanitise-formula-prefix.test.ts`.
  sanitiseFormulaPrefix,
} as const;
