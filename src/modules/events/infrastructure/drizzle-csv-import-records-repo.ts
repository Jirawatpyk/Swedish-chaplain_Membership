/**
 * T020 (Feature 013 / F6.1) — Drizzle `csv_import_records` repository.
 *
 * Implements the persistence surface for F6.1 import-history (US5 deferred)
 * + the FR-019b event-mismatch safety net (US1 MVP — `findByFingerprintAcrossEvents`).
 *
 * Per Constitution Principle III (Clean Architecture):
 *   - Application layer never sees Drizzle types directly — repo returns
 *     plain Domain shapes / branded IDs.
 *   - All queries are tenant-scoped at the application layer (via the
 *     `TenantTx` `executor` parameter, which has `app.current_tenant`
 *     GUC set by `runInTenantTx`); the RLS+FORCE policy from migration
 *     0139 is the second layer of defense.
 *
 * Source-of-truth contract: data-model.md § 1 + § 4.
 */
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { err, ok } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import type { EventId } from '../domain/branded-types';
import type { CsvImportRecordId } from '../domain/csv-import-record-id';
import { csvImportRecords } from './schema';
import { wrapRepoError } from './sanitize-db-error';
import type {
  CsvImportRecordsRepository,
  CsvImportRecordsRepoError,
} from '../application/ports/csv-import-records-repo';

// Re-export port types so route/composition callers can keep a single
// `@/modules/events` barrel import even after the interface moved to the
// application/ports layer (T022 Clean-Arch refactor).
export type {
  CsvImportRecordsRepository,
  CsvImportRecordsRepoError,
  CsvImportRecordOutcome as CsvImportOutcome,
  InsertCsvImportRecordInput,
  UpdateOutcomeInput,
  SetErrorCsvBlobInput,
  FindByFingerprintInput,
  PriorImportMatch,
} from '../application/ports/csv-import-records-repo';

// --- Factory ---------------------------------------------------------------

export function makeDrizzleCsvImportRecordsRepository(
  executor: TenantTx,
): CsvImportRecordsRepository {
  return {
    async insert(input) {
      try {
        await executor.insert(csvImportRecords).values({
          recordId: input.recordId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          eventId: input.eventId,
          sourceFormat: input.sourceFormat,
          originalFilename: input.originalFilename,
          originalSizeBytes: input.originalSizeBytes,
          // Placeholder counts + outcome; finalised by updateOutcome at
          // end of use-case.
          rowsTotal: 0,
          rowsProcessed: 0,
          rowsAlreadyImported: 0,
          rowsSkipped: 0,
          rowsFailed: 0,
          outcome: 'unexpected_error',
          durationMs: 0,
        });
        return ok(undefined);
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async updateOutcome(input) {
      try {
        await executor
          .update(csvImportRecords)
          .set({
            rowsTotal: input.rowsTotal,
            rowsProcessed: input.rowsProcessed,
            rowsAlreadyImported: input.rowsAlreadyImported,
            rowsSkipped: input.rowsSkipped,
            rowsFailed: input.rowsFailed,
            outcome: input.outcome,
            durationMs: input.durationMs,
            attendeeFingerprint: input.attendeeFingerprint,
            eventcreateAdapterMetadata: input.eventcreateAdapterMetadata,
          })
          .where(
            and(
              eq(csvImportRecords.tenantId, input.tenantId),
              eq(csvImportRecords.recordId, input.recordId),
            ),
          );
        return ok(undefined);
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async setErrorCsvBlob(input) {
      try {
        await executor
          .update(csvImportRecords)
          .set({
            errorCsvBlobUrl: input.errorCsvBlobUrl,
            errorCsvExpiresAt: input.errorCsvExpiresAt,
          })
          .where(
            and(
              eq(csvImportRecords.tenantId, input.tenantId),
              eq(csvImportRecords.recordId, input.recordId),
            ),
          );
        return ok(undefined);
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async findByFingerprintAcrossEvents(input) {
      try {
        const rows = await executor
          .select({
            recordId: csvImportRecords.recordId,
            eventId: csvImportRecords.eventId,
            uploadedAt: csvImportRecords.uploadedAt,
          })
          .from(csvImportRecords)
          .where(
            and(
              eq(csvImportRecords.tenantId, input.tenantId),
              eq(csvImportRecords.attendeeFingerprint, input.fingerprint),
              ne(csvImportRecords.eventId, input.currentEventId),
              gt(csvImportRecords.uploadedAt, input.since),
              // Only surface imports that actually committed — drop
              // placeholder rows or never-finalised rows.
              sql`${csvImportRecords.outcome} = 'completed'`,
            ),
          )
          .orderBy(desc(csvImportRecords.uploadedAt));

        return ok(
          rows.map((row) => ({
            recordId: row.recordId as CsvImportRecordId,
            eventId: row.eventId as EventId,
            uploadedAt: row.uploadedAt,
          })),
        );
      } catch (e) {
        return err(wrapDbError(e));
      }
    },
  };
}

// --- Helpers ---------------------------------------------------------------

function wrapDbError(e: unknown): CsvImportRecordsRepoError {
  return wrapRepoError('csvImportRecords', e);
}
