/**
 * T040 (F6.1 · Feature 013 — Phase 5 US5) — `listCsvImportRecords`
 * Application use-case.
 *
 * Returns a paginated history of CSV import records for the
 * `/admin/events/import/history` page (T046). Reverse-chronological by
 * `uploaded_at`. Optional filters by event_id + actor_user_id.
 *
 * Computes `errorCsvAvailable` per row from the persisted
 * (errorCsvBlobUrl, errorCsvExpiresAt) state so the UI shows a disabled
 * "Download error CSV" link once the 30-day blob TTL has passed (or once
 * the sweep cron has cleared the URL).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 * The Drizzle adapter runs the actual paginated SELECT under a
 * tenant-scoped tx (RLS+FORCE enforces the scope; the app-layer
 * `tenantId` filter is the first line of defence).
 */
import type { Result } from '@/lib/result';
import { ok, err } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { EventId } from '../../domain/branded-types';
import type {
  CsvImportRecordsRepository,
  CsvImportRecordsRepoError,
  CsvImportRecordSummary,
} from '../ports/csv-import-records-repo';

export interface ListCsvImportRecordsInput {
  readonly tenantId: TenantId;
  /** 1-based page index. */
  readonly page: number;
  /** Page size; 30 default in the route, capped at 100 by the repo. */
  readonly perPage: number;
  readonly eventIdFilter?: EventId;
  readonly actorUserIdFilter?: UserId;
}

export interface ListCsvImportRecordsRowView {
  readonly record: CsvImportRecordSummary;
  /**
   * Computed from `(errorCsvBlobUrl IS NOT NULL) AND (errorCsvExpiresAt > now())`.
   * The use-case computes this once per response so the UI does not
   * need to re-evaluate per-render.
   */
  readonly errorCsvAvailable: boolean;
}

export interface ListCsvImportRecordsOutput {
  readonly rows: ReadonlyArray<ListCsvImportRecordsRowView>;
  readonly pagination: {
    readonly page: number;
    readonly perPage: number;
    readonly totalRecords: number;
    readonly totalPages: number;
  };
}

export type ListCsvImportRecordsError =
  | { readonly code: 'db_error'; readonly message: string }
  | { readonly code: 'invalid_pagination'; readonly reason: string };

export interface ListCsvImportRecordsDeps {
  readonly csvImportRecordsRepo: CsvImportRecordsRepository;
  /** Injectable for tests; defaults to `new Date()` at call time. */
  readonly clock?: () => Date;
  /**
   * Structured logger for `logger.fatal` on unknown repo error kind
   * (so SREs see future port-shape regressions on dashboards — the
   * route-layer 500 alone is not enough signal). REQUIRED at the
   * boundary; tests that don't care about the surface pass an
   * explicit `{ fatal: () => {} }` no-op (mirrors the sweep deps
   * REQUIRED-callback pattern).
   */
  readonly logger: {
    fatal(meta: Record<string, unknown>, msg: string): void;
  };
}

export async function listCsvImportRecords(
  input: ListCsvImportRecordsInput,
  deps: ListCsvImportRecordsDeps,
): Promise<Result<ListCsvImportRecordsOutput, ListCsvImportRecordsError>> {
  // --- Pagination validation -------------------------------------------
  if (!Number.isInteger(input.page) || input.page < 1) {
    return err({
      code: 'invalid_pagination',
      reason: `page must be a positive integer; received ${input.page}`,
    });
  }
  if (
    !Number.isInteger(input.perPage) ||
    input.perPage < 1 ||
    input.perPage > 100
  ) {
    return err({
      code: 'invalid_pagination',
      reason: `perPage must be an integer in [1,100]; received ${input.perPage}`,
    });
  }

  // --- Repo lookup -----------------------------------------------------
  const result = await deps.csvImportRecordsRepo.listByTenant({
    tenantId: input.tenantId,
    page: input.page,
    perPage: input.perPage,
    ...(input.eventIdFilter !== undefined && { eventIdFilter: input.eventIdFilter }),
    ...(input.actorUserIdFilter !== undefined && {
      actorUserIdFilter: input.actorUserIdFilter,
    }),
  });
  if (!result.ok) return err(mapRepoError(result.error, deps.logger));

  // --- Compute errorCsvAvailable per row -------------------------------
  const now = deps.clock?.() ?? new Date();
  const rows: ListCsvImportRecordsRowView[] = result.value.records.map(
    (record) => ({
      record,
      errorCsvAvailable:
        record.errorCsvBlobUrl !== null &&
        record.errorCsvExpiresAt !== null &&
        record.errorCsvExpiresAt.getTime() > now.getTime(),
    }),
  );

  const totalPages = Math.max(
    1,
    Math.ceil(result.value.totalRecords / input.perPage),
  );

  return ok({
    rows,
    pagination: {
      page: input.page,
      perPage: input.perPage,
      totalRecords: result.value.totalRecords,
      totalPages,
    },
  });
}

function mapRepoError(
  e: CsvImportRecordsRepoError,
  logger: ListCsvImportRecordsDeps['logger'],
): ListCsvImportRecordsError {
  if (e.kind === 'db_error') return { code: 'db_error', message: e.message };
  // Unknown error kind = the repo port grew a new variant that this
  // caller hasn't been taught about. Emit logger.fatal so SREs see
  // the regression on dashboards. The route maps the generic
  // 'db_error' to 500, which is the correct user-facing surface.
  logger.fatal(
    { event: 'f6_csv_list_repo_unknown_error_kind', errKind: e.kind },
    '[F6.1] listCsvImportRecords repo returned unknown error kind — port-shape regression',
  );
  return { code: 'db_error', message: `unexpected repo error: ${e.kind}` };
}
