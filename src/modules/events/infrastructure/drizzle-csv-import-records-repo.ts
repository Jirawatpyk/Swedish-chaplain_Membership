/**
 * T020 (Feature 013 / F6.1) — Drizzle `csv_import_records` repository.
 *
 * Implements the persistence surface for F6.1 import-history (US5) +
 * the FR-019b event-mismatch safety net (US1 — `findByFingerprintAcrossEvents`).
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
import { and, count, desc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { err, ok } from '@/lib/result';
import { db as defaultDb, type TenantTx } from '@/lib/db';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { EventId } from '../domain/branded-types';
import type { CsvImportRecordId } from '../domain/csv-import-record-id';
import { csvImportRecords } from './schema';
import { wrapRepoError } from './sanitize-db-error';
import type {
  CsvImportRecordsRepository,
  CsvImportRecordsAdminRepository,
  CsvImportRecordsRepoError,
  CsvImportRecordSummary,
  ExpiredBlobRow,
} from '../application/ports/csv-import-records-repo';

// Re-export port types so route/composition callers can keep a single
// `@/modules/events` barrel import even after the interface moved to the
// application/ports layer (T022 Clean-Arch refactor).
export type {
  CsvImportRecordsRepository,
  CsvImportRecordsAdminRepository,
  CsvImportRecordsRepoError,
  CsvImportRecordOutcome as CsvImportOutcome,
  CsvImportRecordSummary,
  ExpiredBlobRow,
  InsertCsvImportRecordInput,
  UpdateOutcomeInput,
  SetErrorCsvBlobInput,
  FindByFingerprintInput,
  ListByTenantInput,
  ListByTenantResult,
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
        // CR-5 (Round 1 — silent-failure-hunter): use `.returning()`
        // to detect zero-rows-affected, which means the placeholder
        // INSERT never landed (constraint violation, RLS denial, etc.).
        // Previously the UPDATE silently returned `ok(undefined)`
        // even when no row existed — admin saw a successful import
        // but the import-history row was missing, breaking the
        // FR-019c forensic invariant. Now: caller can distinguish
        // updated-row from no-row-existed and decide on degradation.
        const updated = await executor
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
          )
          .returning({ recordId: csvImportRecords.recordId });
        if (updated.length === 0) {
          return err({
            kind: 'not_found',
          });
        }
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
              // I4 (Round 1 — silent-failure-hunter): include
              // 'partial_failure' AND 'timeout' priors because both
              // outcomes COMMIT rows (only the placeholder default
              // 'unexpected_error' is the truly-never-ran sentinel
              // to exclude). Previously dropping partial_failure +
              // timeout silently made the FR-019b safety net miss
              // the most common partial-commit scenario.
              sql`${csvImportRecords.outcome} IN ('completed', 'partial_failure', 'timeout')`,
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

    async listByTenant(input) {
      try {
        const perPage = Math.max(1, Math.min(100, input.perPage));
        const page = Math.max(1, input.page);
        const offset = (page - 1) * perPage;

        const filters = [eq(csvImportRecords.tenantId, input.tenantId)];
        if (input.eventIdFilter !== undefined) {
          filters.push(eq(csvImportRecords.eventId, input.eventIdFilter));
        }
        if (input.actorUserIdFilter !== undefined) {
          filters.push(
            eq(csvImportRecords.actorUserId, input.actorUserIdFilter),
          );
        }
        const whereClause = and(...filters);

        const rows = await executor
          .select()
          .from(csvImportRecords)
          .where(whereClause)
          .orderBy(desc(csvImportRecords.uploadedAt))
          .limit(perPage)
          .offset(offset);

        const totalRows = await executor
          .select({ value: count() })
          .from(csvImportRecords)
          .where(whereClause);
        const totalRecords = totalRows[0]?.value ?? 0;

        return ok({
          records: rows.map(rowToSummary),
          totalRecords: Number(totalRecords),
        });
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async findById(tenantId, recordId) {
      try {
        const rows = await executor
          .select()
          .from(csvImportRecords)
          .where(
            and(
              eq(csvImportRecords.tenantId, tenantId),
              eq(csvImportRecords.recordId, recordId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return err({ kind: 'not_found' });
        return ok(rowToSummary(row));
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async clearErrorCsvBlob(tenantId, recordId) {
      try {
        await executor
          .update(csvImportRecords)
          .set({
            errorCsvBlobUrl: null,
            errorCsvExpiresAt: null,
          })
          .where(
            and(
              eq(csvImportRecords.tenantId, tenantId),
              eq(csvImportRecords.recordId, recordId),
            ),
          );
        return ok(undefined);
      } catch (e) {
        return err(wrapDbError(e));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// F6.1 Phase 5 US5 (T041 + T049) — admin-bypass adapter
// ---------------------------------------------------------------------------
//
// Bypasses the tenant-scope GUC; executes against the owner role
// (BYPASSRLS) so cross-tenant queries succeed. Matches the F4
// receipt-pdf-reconcile cron pattern (route-level bulk-read without
// runInTenantTx).

export function makeDrizzleCsvImportRecordsAdminRepository(
  database: typeof defaultDb = defaultDb,
): CsvImportRecordsAdminRepository {
  return {
    async findByIdAcrossTenants(recordId) {
      try {
        const rows = await database
          .select({ tenantId: csvImportRecords.tenantId })
          .from(csvImportRecords)
          .where(eq(csvImportRecords.recordId, recordId))
          .limit(1);
        const row = rows[0];
        if (!row) return ok(null);
        return ok({ tenantId: row.tenantId as TenantId });
      } catch (e) {
        return err(wrapDbError(e));
      }
    },

    async listExpiredErrorCsvBlobsAllTenants(cutoff, limit) {
      try {
        const rows = await database
          .select({
            recordId: csvImportRecords.recordId,
            tenantId: csvImportRecords.tenantId,
            errorCsvBlobUrl: csvImportRecords.errorCsvBlobUrl,
            errorCsvExpiresAt: csvImportRecords.errorCsvExpiresAt,
          })
          .from(csvImportRecords)
          .where(
            and(
              isNotNull(csvImportRecords.errorCsvBlobUrl),
              isNotNull(csvImportRecords.errorCsvExpiresAt),
              lt(csvImportRecords.errorCsvExpiresAt, cutoff),
            ),
          )
          .limit(limit);
        return ok(
          rows
            .filter(
              (r): r is typeof r & { errorCsvBlobUrl: string; errorCsvExpiresAt: Date } =>
                r.errorCsvBlobUrl !== null && r.errorCsvExpiresAt !== null,
            )
            .map<ExpiredBlobRow>((r) => ({
              recordId: r.recordId as CsvImportRecordId,
              tenantId: r.tenantId as TenantId,
              errorCsvBlobUrl: r.errorCsvBlobUrl,
              errorCsvExpiresAt: r.errorCsvExpiresAt,
            })),
        );
      } catch (e) {
        return err(wrapDbError(e));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper — Drizzle row → port-shaped summary
// ---------------------------------------------------------------------------

type CsvImportRecordRow = typeof csvImportRecords.$inferSelect;

/**
 * Drizzle's inferSelect widens enum + CHECK-constrained `TEXT` columns
 * to plain `string`. The DB enforces `source_format IN ('eventcreate_csv',
 * 'generic_csv')` and the `outcome` CHECK; rows that don't conform never
 * reach the application layer. Narrowing here is therefore a safe cast.
 */
function rowToSummary(row: CsvImportRecordRow): CsvImportRecordSummary {
  return {
    recordId: row.recordId as CsvImportRecordId,
    tenantId: row.tenantId as TenantId,
    actorUserId: row.actorUserId as UserId,
    eventId: row.eventId as EventId,
    uploadedAt: row.uploadedAt,
    sourceFormat: row.sourceFormat as CsvImportRecordSummary['sourceFormat'],
    originalFilename: row.originalFilename,
    originalSizeBytes: row.originalSizeBytes,
    rowsTotal: row.rowsTotal,
    rowsProcessed: row.rowsProcessed,
    rowsAlreadyImported: row.rowsAlreadyImported,
    rowsSkipped: row.rowsSkipped,
    rowsFailed: row.rowsFailed,
    outcome: row.outcome as CsvImportRecordSummary['outcome'],
    durationMs: row.durationMs,
    errorCsvBlobUrl: row.errorCsvBlobUrl,
    errorCsvExpiresAt: row.errorCsvExpiresAt,
  };
}

// --- Helpers ---------------------------------------------------------------

function wrapDbError(e: unknown): CsvImportRecordsRepoError {
  return wrapRepoError('csvImportRecords', e);
}
