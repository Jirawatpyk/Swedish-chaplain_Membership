/**
 * T049 (F6.1 · Feature 013 — Phase 5 US5) —
 * `sweepExpiredErrorCsvBlobs` Application use-case.
 *
 * Daily TTL sweep cron driver (T050 route handler). Reads expired rows
 * across all tenants via the admin-bypass repo, then per-row deletes the
 * Vercel Blob + clears `error_csv_blob_url` / `error_csv_expires_at`
 * scoped into the row's tenant. Idempotent: re-running after partial
 * failures retries only the still-expired rows.
 *
 * Matches the F4 receipt-pdf-reconcile cron pattern: bulk-read bypasses
 * RLS, per-row write executes inside `runInTenant(asTenantContext(...))`
 * so RLS enforces the tenant scope on the UPDATE. Composition layer
 * (T050 cron handler) wires the `withTenantScope` callback.
 *
 * Failure handling:
 *   - Blob `delete` returns `blob_not_found` → idempotent success (the
 *     blob was already swept; just clear the DB row).
 *   - Blob `delete` returns `storage_error` → skip the row + emit pino
 *     warn; the row is re-attempted on the next cron run.
 *   - `clearErrorCsvBlob` DB failure → skip the row + emit pino warn;
 *     the next cron run retries.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import { ok } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { CsvImportRecordId } from '../../domain/csv-import-record-id';
import type {
  CsvImportRecordsRepository,
  CsvImportRecordsAdminRepository,
} from '../ports/csv-import-records-repo';
import type { ErrorCsvStore } from '../ports/error-csv-store';

export interface SweepExpiredErrorCsvBlobsInput {
  /** Defaults to 100 — caps per-cron-run work to keep DB load bounded. */
  readonly limit?: number;
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => Date;
}

/**
 * Discriminated outcome for the sweep cron. The `scan_failed` variant
 * makes "scan failed implies no work done" unrepresentable — earlier
 * shape (`{ scanFailed: boolean; sweptCount; skippedCount; ... }`)
 * permitted `{ scanFailed: true, sweptCount: 5 }` which is semantically
 * nonsensical. The route maps `kind:'scan_failed'` → 500 so
 * cron-job.org "2 consecutive failures" alert fires.
 */
export type SweepExpiredErrorCsvBlobsOutput =
  | {
      readonly kind: 'ok';
      /** Number of expired rows the read step returned. */
      readonly candidatesScanned: number;
      /** Number of rows whose blob was deleted + DB column cleared. */
      readonly sweptCount: number;
      /** Number of rows skipped due to blob delete or DB update failure. */
      readonly skippedCount: number;
      readonly cutoff: Date;
    }
  | {
      readonly kind: 'scan_failed';
      readonly cutoff: Date;
    };

export interface SweepExpiredErrorCsvBlobsDeps {
  readonly csvImportRecordsAdminRepo: CsvImportRecordsAdminRepository;
  readonly errorCsvStore: ErrorCsvStore;
  /**
   * Composition-layer callback: opens a tenant-scoped tx for the given
   * tenant slug + invokes `fn` with a `CsvImportRecordsRepository`
   * scoped to that tenant. The cron handler (T050) wires this to
   * `runInTenant(asTenantContext(tenantId), tx => makeRepo(tx))`.
   */
  readonly withTenantScope: <T>(
    tenantId: TenantId,
    fn: (repo: CsvImportRecordsRepository) => Promise<T>,
  ) => Promise<T>;
  readonly logger?: {
    info(meta: Record<string, unknown>, msg: string): void;
    warn(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
  /**
   * Increments `csvErrorCsvSweepClearFailed(tenantId)` when the
   * post-blob-delete DB clear fails. REQUIRED at the boundary — pass
   * an explicit no-op `() => {}` in tests that don't care about the
   * metric. Composition layer wires the OTel counter. Earlier this
   * was optional, which let a test/composition silently forget the
   * metric and lose SRE alerting visibility.
   */
  readonly onSweepClearFailed: (tenantId: TenantId) => void;
  /** Increments `csvSweepScanFailed()` when bulk-scan fails. REQUIRED. */
  readonly onScanFailed: () => void;
}

export async function sweepExpiredErrorCsvBlobs(
  input: SweepExpiredErrorCsvBlobsInput,
  deps: SweepExpiredErrorCsvBlobsDeps,
): Promise<Result<SweepExpiredErrorCsvBlobsOutput, never>> {
  const limit = Math.max(1, Math.min(1000, input.limit ?? 100));
  const cutoff = input.clock?.() ?? new Date();
  const logger = deps.logger;

  // --- Step 1: scan expired rows (admin-bypass) -----------------------
  const scanResult =
    await deps.csvImportRecordsAdminRepo.listExpiredErrorCsvBlobsAllTenants(
      cutoff,
      limit,
    );
  if (!scanResult.ok) {
    // Elevate to `logger.error` so SRE dashboards fire on scan
    // failures (see `SweepExpiredErrorCsvBlobsOutput` JSDoc for the
    // `kind:'scan_failed'` → 500 route contract).
    logger?.error(
      {
        event: 'f6_error_csv_sweep_scan_failed',
        cutoff: cutoff.toISOString(),
        err: scanResult.error.kind,
      },
      '[F6.1] sweep cron: scan step failed; route will return 500',
    );
    deps.onScanFailed();
    return ok({ kind: 'scan_failed', cutoff });
  }

  const candidates = scanResult.value;
  let sweptCount = 0;
  let skippedCount = 0;

  // --- Step 2: per-row delete + clear ---------------------------------
  for (const candidate of candidates) {
    const swept = await sweepOne(candidate, deps, logger);
    if (swept) sweptCount += 1;
    else skippedCount += 1;
  }

  logger?.info(
    {
      event: 'f6_error_csv_sweep_completed',
      cutoff: cutoff.toISOString(),
      candidatesScanned: candidates.length,
      sweptCount,
      skippedCount,
    },
    `[F6.1] sweep cron complete: ${sweptCount}/${candidates.length} blobs deleted`,
  );

  return ok({
    kind: 'ok',
    candidatesScanned: candidates.length,
    sweptCount,
    skippedCount,
    cutoff,
  });
}

async function sweepOne(
  candidate: {
    readonly recordId: CsvImportRecordId;
    readonly tenantId: TenantId;
    readonly errorCsvBlobUrl: string;
  },
  deps: SweepExpiredErrorCsvBlobsDeps,
  logger: SweepExpiredErrorCsvBlobsDeps['logger'],
): Promise<boolean> {
  // Delete the blob first; `blob_not_found` counts as success (cron is
  // idempotent — re-runs after partial failure may re-try a row whose
  // blob is already gone).
  const deleteResult = await deps.errorCsvStore.delete({
    blobUrl: candidate.errorCsvBlobUrl,
  });
  if (!deleteResult.ok && deleteResult.error.kind !== 'blob_not_found') {
    logger?.warn(
      {
        event: 'f6_error_csv_sweep_blob_delete_failed',
        tenantId: candidate.tenantId,
        recordId: candidate.recordId,
        errKind: deleteResult.error.kind,
      },
      '[F6.1] sweep cron: blob delete failed; will retry next run',
    );
    return false;
  }

  // Clear the DB columns inside the tenant scope so RLS approves the
  // UPDATE.
  try {
    const updateResult = await deps.withTenantScope(
      candidate.tenantId,
      async (repo) =>
        repo.clearErrorCsvBlob(candidate.tenantId, candidate.recordId),
    );
    if (!updateResult.ok) {
      // Elevate to ERROR + emit metric. Orphan blob-url pointer left
      // in DB → next-run idempotent retry will see `blob_not_found`
      // and re-attempt the clear; sustained `rate > 0` indicates a
      // persistent RLS / pool issue.
      logger?.error(
        {
          event: 'f6_error_csv_sweep_clear_failed',
          tenantId: candidate.tenantId,
          recordId: candidate.recordId,
          errKind: updateResult.error.kind,
        },
        '[F6.1] sweep cron: clearErrorCsvBlob FAILED after blob delete — orphan DB pointer (next-run idempotent retry)',
      );
      deps.onSweepClearFailed(candidate.tenantId);
      return false;
    }
  } catch (e) {
    logger?.error(
      {
        event: 'f6_error_csv_sweep_clear_threw',
        tenantId: candidate.tenantId,
        recordId: candidate.recordId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] sweep cron: clearErrorCsvBlob THREW after blob delete — investigate runInTenant outage',
    );
    deps.onSweepClearFailed(candidate.tenantId);
    return false;
  }

  return true;
}
