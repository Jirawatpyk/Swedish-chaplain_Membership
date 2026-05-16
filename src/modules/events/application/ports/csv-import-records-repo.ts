/**
 * F6.1 (Feature 013 · T020) — `CsvImportRecordsRepository` Application port.
 *
 * Contract for the F6.1 `csv_import_records` persistence surface (table
 * created by migration 0139). The Drizzle adapter
 * (`infrastructure/drizzle-csv-import-records-repo.ts`) implements this
 * interface; the `importCsv` Application use-case (T022) consumes only
 * this port, never the Drizzle types — Constitution Principle III
 * compliance.
 *
 * Surfaces:
 *   - `insert`                          → placeholder row at use-case start
 *   - `updateOutcome`                   → final counts + outcome at use-case end
 *   - `setErrorCsvBlob`                 → US1 path when `rowsFailed > 0`
 *   - `findByFingerprintAcrossEvents`   → FR-019b safety-net query
 *
 * Lifecycle:
 *   1. `insert` (placeholder, outcome='unexpected_error', counts=0) BEFORE batches.
 *   2. Run batches.
 *   3. `setErrorCsvBlob` if `rowsFailed > 0` (US1 reads back via US5 download route).
 *   4. `updateOutcome` (final counts + outcome + fingerprint + adapter metadata).
 *
 * Per Constitution Principle I sub-clause 2 (DB-layer tenant isolation),
 * the table has RLS+FORCE — every method REQUIRES `tenantId` for the
 * application-layer filter AND the executor MUST have
 * `app.current_tenant` GUC set by `runInTenant(...)` for the policy to
 * approve the row visibility.
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { EventId } from '../../domain/branded-types';
import type { CsvImportRecordId } from '../../domain/csv-import-record-id';

// --- Inputs ----------------------------------------------------------------

export interface InsertCsvImportRecordInput {
  readonly recordId: CsvImportRecordId;
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  readonly eventId: EventId;
  readonly sourceFormat: 'eventcreate_csv' | 'generic_csv';
  readonly originalFilename: string;
  readonly originalSizeBytes: number;
}

/**
 * Final outcome row written at use-case end. `outcome` mirrors the
 * `ImportCsvOutcome.kind` discriminator (use-case side); the DB enum
 * values are documented in `data-model.md § 1`.
 */
export type CsvImportRecordOutcome =
  | 'completed'
  | 'timeout'
  | 'partial_failure'
  | 'invalid_header'
  | 'event_not_found'
  | 'event_not_owned_by_tenant'
  | 'unexpected_error';

export interface UpdateOutcomeInput {
  readonly recordId: CsvImportRecordId;
  readonly tenantId: TenantId;
  readonly rowsTotal: number;
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly outcome: CsvImportRecordOutcome;
  readonly durationMs: number;
  readonly attendeeFingerprint: string | null;
  readonly eventcreateAdapterMetadata: Record<string, unknown> | null;
}

export interface SetErrorCsvBlobInput {
  readonly recordId: CsvImportRecordId;
  readonly tenantId: TenantId;
  readonly errorCsvBlobUrl: string;
  /** Persist `now() + 30 days` per data-model.md § 1 lifecycle step 3. */
  readonly errorCsvExpiresAt: Date;
}

export interface FindByFingerprintInput {
  readonly tenantId: TenantId;
  readonly fingerprint: string;
  /** Exclude imports targeting this event — only return cross-event matches. */
  readonly currentEventId: EventId;
  /** Filter to imports newer than `since` (typically `now() - 30 days`). */
  readonly since: Date;
}

export interface PriorImportMatch {
  readonly recordId: CsvImportRecordId;
  readonly eventId: EventId;
  readonly uploadedAt: Date;
}

// --- F6.1 Phase 5 US5 (T040 list, T041 signed-URL, T049 sweep) -------------

export interface ListByTenantInput {
  readonly tenantId: TenantId;
  /** 1-based page index. */
  readonly page: number;
  /** Page size, capped at 100 by the use-case. */
  readonly perPage: number;
  /** Optional filter by event_id. */
  readonly eventIdFilter?: EventId;
  /** Optional filter by actor user_id. */
  readonly actorUserIdFilter?: UserId;
}

export interface CsvImportRecordSummary {
  readonly recordId: CsvImportRecordId;
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  readonly eventId: EventId;
  readonly uploadedAt: Date;
  readonly sourceFormat: 'eventcreate_csv' | 'generic_csv';
  readonly originalFilename: string;
  readonly originalSizeBytes: number;
  readonly rowsTotal: number;
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly outcome: CsvImportRecordOutcome;
  readonly durationMs: number;
  readonly errorCsvBlobUrl: string | null;
  readonly errorCsvExpiresAt: Date | null;
}

export interface ListByTenantResult {
  readonly records: ReadonlyArray<CsvImportRecordSummary>;
  /** Total count for the filter — feeds the totalPages computation. */
  readonly totalRecords: number;
}

export interface ExpiredBlobRow {
  readonly recordId: CsvImportRecordId;
  readonly tenantId: TenantId;
  readonly errorCsvBlobUrl: string;
  readonly errorCsvExpiresAt: Date;
}

// --- Repo error envelope ---------------------------------------------------

export type CsvImportRecordsRepoError =
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'not_found' };

// --- Port interface --------------------------------------------------------

export interface CsvImportRecordsRepository {
  insert(
    input: InsertCsvImportRecordInput,
  ): Promise<Result<void, CsvImportRecordsRepoError>>;

  updateOutcome(
    input: UpdateOutcomeInput,
  ): Promise<Result<void, CsvImportRecordsRepoError>>;

  setErrorCsvBlob(
    input: SetErrorCsvBlobInput,
  ): Promise<Result<void, CsvImportRecordsRepoError>>;

  /**
   * FR-019b — returns prior imports for the same tenant whose
   * `attendee_fingerprint` matches the given fingerprint, targeting a
   * DIFFERENT event than `currentEventId`, within the last 30 days.
   * Result is reverse-chronological so the most-recent match is first.
   */
  findByFingerprintAcrossEvents(
    input: FindByFingerprintInput,
  ): Promise<
    Result<ReadonlyArray<PriorImportMatch>, CsvImportRecordsRepoError>
  >;

  /**
   * F6.1 Phase 5 US5 (T040) — paginated history listing for the US5
   * /admin/events/import/history page. Reverse-chronological by
   * `uploaded_at`. Filters by event + actor are optional + combinable.
   * Returns the matching records + total count for pagination.
   */
  listByTenant(
    input: ListByTenantInput,
  ): Promise<Result<ListByTenantResult, CsvImportRecordsRepoError>>;

  /**
   * F6.1 Phase 5 US5 (T041) — fetch a single import record by (tenant,
   * recordId). RLS+FORCE enforces that records belonging to other
   * tenants are invisible — callers receive `kind:'not_found'` in
   * that case (the same response as record-does-not-exist, satisfying
   * the surface-disclosure invariant of the signed-URL route).
   */
  findById(
    tenantId: TenantId,
    recordId: CsvImportRecordId,
  ): Promise<
    Result<CsvImportRecordSummary, CsvImportRecordsRepoError>
  >;

  /**
   * F6.1 Phase 5 US5 (T049) — sweep cron clears `error_csv_blob_url` +
   * `error_csv_expires_at` for a single record after the cron has
   * successfully deleted the underlying blob. Idempotent — re-run
   * after a partial failure is a no-op.
   */
  clearErrorCsvBlob(
    tenantId: TenantId,
    recordId: CsvImportRecordId,
  ): Promise<Result<void, CsvImportRecordsRepoError>>;
}

/**
 * F6.1 Phase 5 US5 (T041 + T049) — admin-bypass repo for cross-tenant
 * operations:
 *   - `findByIdAcrossTenants` is used by the signed-URL route to detect
 *     cross-tenant probes (Constitution Principle I clause 4) — the
 *     route checks whether a recordId exists at all (without the actor's
 *     tenant filter), then compares the row's tenant to the actor's;
 *     mismatch → 404 + HIGH-severity `csv_import_cross_tenant_probe`
 *     audit. The row data is NEVER returned to the actor.
 *   - `listExpiredErrorCsvBlobsAllTenants` is the cron's read step.
 *     Per the F4 receipt-pdf-reconcile precedent, the cron handler
 *     bulk-reads bypassing RLS, then iterates rows + scopes each
 *     mutation into `runInTenant(...)` for the per-row delete + clear.
 */
export interface CsvImportRecordsAdminRepository {
  findByIdAcrossTenants(
    recordId: CsvImportRecordId,
  ): Promise<
    Result<
      { readonly tenantId: TenantId } | null,
      CsvImportRecordsRepoError
    >
  >;

  listExpiredErrorCsvBlobsAllTenants(
    cutoff: Date,
    limit: number,
  ): Promise<
    Result<ReadonlyArray<ExpiredBlobRow>, CsvImportRecordsRepoError>
  >;
}
