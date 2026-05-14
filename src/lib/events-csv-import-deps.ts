/**
 * F6 CSV import composition adapter (T095).
 *
 * Wires the route handler `src/app/api/admin/events/import/route.ts` to:
 *   - `csvImportRateLimitCheck` — Upstash sliding-window 5 imports/hr
 *     per (tenant, actor) per FR-005 + contracts/csv-import-api.md.
 *   - `runImportCsv` — composition over the `importCsv` Application
 *     use-case + `makeImportCsvDeps()` Infrastructure factory.
 *   - `ImportSummary` re-export for the route's 200 response body.
 *
 * Pattern mirrors:
 *   - `src/lib/events-webhook-deps.ts` — F6 webhook composition.
 *   - `src/lib/events-admin-integration-deps.ts` — F6 admin route
 *     composition with per-(tenant, actor) rate-limit factories.
 *
 * **Principle III note**: `src/lib/**` is in the ESLint
 * `no-restricted-imports` allow-list (composition adapter layer). Route
 * handlers + tests import from this file; Application use-cases never
 * reach into `src/lib/**`.
 */
import { rateLimiter as authRateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { eventcreateMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import {
  importCsv,
  makeImportCsvDeps,
  type ImportCsvOutcome,
  type ImportSummary,
} from '@/modules/events';
import type { UserId } from '@/modules/auth';

// ---------------------------------------------------------------------------
// Rate-limit
// ---------------------------------------------------------------------------

const F6_CSV_IMPORT_MAX_PER_HOUR = 5;
const F6_CSV_IMPORT_WINDOW_SECONDS = 3600;

export interface CsvImportRateLimitResult {
  readonly success: boolean;
  /** Unix-ms timestamp when the bucket resets. */
  readonly resetAtUnixMs: number;
}

/**
 * Per-(tenant, actor) rate-limit gate per FR-005 + contracts/csv-import-api.md.
 * Sliding-window 5/hr — Upstash `f6-csv-import:{tenantSlug}:{actorUserId}`.
 * Inherits Upstash fail-open from the auth rate-limiter adapter; emits
 * `eventcreate_csv_import_rate_limit_fallback_total` so SREs can alert
 * on Upstash outages without losing the route's availability.
 *
 * M-2 fix (2026-05-15): fail-open now also logs a `warn` line so a
 * post-incident audit can identify which actor imported during the
 * Upstash outage (security investigation visibility — bypassed rate
 * limits during cross-tenant abuse scenarios).
 */
export async function csvImportRateLimitCheck(
  tenantSlug: string,
  actorUserId: string,
): Promise<CsvImportRateLimitResult> {
  const result = await authRateLimiter.check(
    `f6-csv-import:${tenantSlug}:${actorUserId}`,
    F6_CSV_IMPORT_MAX_PER_HOUR,
    F6_CSV_IMPORT_WINDOW_SECONDS,
  );
  if (result.fellBack) {
    eventcreateMetrics.csvImportRateLimitFallback(tenantSlug);
    logger.warn(
      {
        event: 'f6_csv_import_rate_limit_fell_open',
        tenantSlug,
        actorUserId,
      },
      '[F6] CSV-import rate limit Upstash unreachable — fell open to in-memory bucket (per-process only). Post-incident: this actor may have exceeded the documented 5/hr cap during outage.',
    );
  }
  return { success: result.success, resetAtUnixMs: result.reset };
}

// ---------------------------------------------------------------------------
// runImportCsv composition wrapper
// ---------------------------------------------------------------------------

export interface RunImportCsvInput {
  readonly tenantSlug: string;
  /**
   * H-15 fix (2026-05-15): branded UserId at the boundary instead of
   * `string` with internal `as UserId` cast. Route handler brands via
   * `asUserId(session.user.id)` before invoking. Matches F4/F5
   * branding pattern at composition adapters.
   */
  readonly actorUserId: UserId;
  readonly bytes: Uint8Array;
  readonly columnMapping?: ReadonlyMap<string, string>;
}

/**
 * H-14 fix (2026-05-15): collapse duplicate discriminated-union to a
 * type alias. Previously declared a structurally-identical clone of
 * `ImportCsvOutcome` here — drift risk if Application added a 5th
 * variant. Now re-aliases the canonical Application type so future
 * variants propagate automatically.
 */
export type RunImportCsvOutcome = ImportCsvOutcome;

/**
 * Invoke the `importCsv` Application use-case with a fresh
 * `makeImportCsvDeps()` factory. Surface the result discriminated
 * union verbatim — the route handler maps each kind to its HTTP
 * status (200 / 400 / 504 / 500).
 */
export async function runImportCsv(
  input: RunImportCsvInput,
): Promise<RunImportCsvOutcome> {
  const deps = makeImportCsvDeps();
  const outcome = await importCsv(
    {
      tenantId: input.tenantSlug,
      actorUserId: input.actorUserId,
      bytes: input.bytes,
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
    },
    deps,
  );
  return outcome;
}

// Re-export the summary shape so the route handler has a single
// import path for the 200-response body type.
export type { ImportSummary };
