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
}
