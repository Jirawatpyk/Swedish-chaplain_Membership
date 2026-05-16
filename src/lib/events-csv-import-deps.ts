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
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  importCsv,
  makeImportCsvDeps,
  asEventId,
  asCsvImportRecordId,
  type CsvImportRecordId,
  type EventId,
  listCsvImportRecords,
  type ListCsvImportRecordsOutput,
  type ListCsvImportRecordsError,
  generateErrorCsvSignedUrl,
  type GenerateErrorCsvSignedUrlOutcome,
  sweepExpiredErrorCsvBlobs,
  type SweepExpiredErrorCsvBlobsOutput,
  makeDrizzleCsvImportRecordsRepository,
  makeDrizzleCsvImportRecordsAdminRepository,
  vercelBlobErrorCsvStore,
  makeStandaloneAuditDeps,
  type ImportCsvOutcome,
  type ImportSummary,
  type SelectedEventForImport,
} from '@/modules/events';
import type { F6AuditEntry, F6AuditEventType, F6AuditPort } from '@/modules/events/application/ports/audit-port';
import type { UserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import type { Result } from '@/lib/result';

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
  /**
   * F6.1 (Feature 013 · T024) — Admin-selected event metadata from the
   * timing-safe event-lookup performed by the route handler. The route
   * passes a validated-string `eventId`; the composition layer brands
   * it to `EventId` here (pass-2 finding G3 closure — route-layer
   * stays framework-aware; composition-layer is domain-aware).
   */
  readonly selectedEvent: {
    readonly eventId: string;
    readonly externalId: string;
    readonly name: string;
    readonly startDate: Date;
    readonly category: string | null;
  };
  /** F6.1 (FR-019c) — admin bypass for the event-mismatch safety net. */
  readonly forceProceed?: boolean;
  /** F6.1 — original filename for `csv_import_records.original_filename`. */
  readonly originalFilename?: string;
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
  // F6.1 (T024 sub-task e) — brand the validated-string event_id to
  // `EventId` at the composition layer. Route stays framework-aware
  // (no `@/modules/events` domain imports for branding); composition
  // owns the brand application.
  const selectedEvent: SelectedEventForImport = {
    eventId: asEventId(input.selectedEvent.eventId),
    externalId: input.selectedEvent.externalId,
    name: input.selectedEvent.name,
    startDate: input.selectedEvent.startDate,
    category: input.selectedEvent.category,
  };
  const outcome = await importCsv(
    {
      // Brand at the composition boundary so the use-case never sees
      // an unbranded string (matches the H-15 pattern for actorUserId).
      tenantId: asTenantId(input.tenantSlug),
      actorUserId: input.actorUserId,
      bytes: input.bytes,
      selectedEvent,
      ...(input.forceProceed !== undefined && {
        forceProceed: input.forceProceed,
      }),
      ...(input.originalFilename !== undefined && {
        originalFilename: input.originalFilename,
      }),
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
      // T053 (F6.1 Phase 6) — sub-flag rollback safety net. When OFF,
      // the parser skips EventCreate detection + forces generic-CSV
      // path even if the header matches the 6 EventCreate columns.
      // Read once at composition time so a flag flip drains in seconds
      // for new requests; in-flight imports complete normally per E14.
      adapterEnabled: env.features.f6EventCreateAdapter,
    },
    deps,
  );
  return outcome;
}

// Re-export the summary shape so the route handler has a single
// import path for the 200-response body type.
export type { ImportSummary };

// ---------------------------------------------------------------------------
// F6.1 (Feature 013 · T023) — Timing-safe event lookup
// ---------------------------------------------------------------------------

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

/**
 * Outcome of the route-layer event lookup. Maps onto contract responses:
 *   - `found`        → continue to use-case dispatch
 *   - `not_found`    → 400 `event_not_found`
 *   - `wrong_tenant` → 404 `event_not_owned_by_tenant` (surface-disclosure
 *                       per FR-035) + emit `csv_import_cross_tenant_probe`
 *                       audit (Constitution Principle I clause 4)
 */
export type EventLookupResult =
  | {
      readonly kind: 'found';
      readonly event: {
        readonly eventId: string;
        readonly externalId: string;
        readonly name: string;
        readonly startDate: Date;
        readonly category: string | null;
      };
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'wrong_tenant'; readonly ownerTenantSlug: string };

interface EventLookupRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly external_id: string;
  readonly name: string;
  readonly start_date: string;
  readonly category: string | null;
}

// ---------------------------------------------------------------------------
// F6.1 Phase 5 US5 — runListCsvImportRecords composition wrapper (T040)
// ---------------------------------------------------------------------------

export interface RunListCsvImportRecordsInput {
  readonly tenantSlug: string;
  readonly page: number;
  readonly perPage: number;
  /** Validated-string event_id; branded inside the wrapper. */
  readonly eventIdFilter?: string;
  /** Validated-string actor user_id (no branding required — UserId is string). */
  readonly actorUserIdFilter?: UserId;
}

export async function runListCsvImportRecords(
  input: RunListCsvImportRecordsInput,
): Promise<Result<ListCsvImportRecordsOutput, ListCsvImportRecordsError>> {
  return runInTenant(asTenantContext(input.tenantSlug), async (tx) => {
    const repo = makeDrizzleCsvImportRecordsRepository(tx);
    return listCsvImportRecords(
      {
        tenantId: asTenantId(input.tenantSlug),
        page: input.page,
        perPage: input.perPage,
        ...(input.eventIdFilter !== undefined && {
          eventIdFilter: asEventId(input.eventIdFilter),
        }),
        ...(input.actorUserIdFilter !== undefined && {
          actorUserIdFilter: input.actorUserIdFilter,
        }),
      },
      { csvImportRecordsRepo: repo },
    );
  });
}

// ---------------------------------------------------------------------------
// F6.1 Phase 5 US5 — runGenerateErrorCsvSignedUrl wrapper (T041)
// ---------------------------------------------------------------------------

export interface RunGenerateErrorCsvSignedUrlInput {
  readonly tenantSlug: string;
  readonly actorUserId: UserId;
  /** Validated-UUID recordId; branded inside the wrapper. */
  readonly recordId: string;
  readonly sourceIp: string;
}

export async function runGenerateErrorCsvSignedUrl(
  input: RunGenerateErrorCsvSignedUrlInput,
): Promise<GenerateErrorCsvSignedUrlOutcome> {
  return runInTenant(asTenantContext(input.tenantSlug), async (tx) => {
    const repo = makeDrizzleCsvImportRecordsRepository(tx);
    const adminRepo = makeDrizzleCsvImportRecordsAdminRepository();
    // The audit port writes inside the current tx scope (`emit`).
    // Use the standalone audit port for cross-tenant probe events
    // (those must commit independently of the calling tx).
    const audit = makePinoAuditPort(tx);
    const standalone = makeStandaloneAuditDeps();
    // Compose a hybrid F6AuditPort that uses `emit` for success path
    // (in-tx commit) AND routes cross-tenant probe + downloaded audits
    // through standalone-tx so they survive even when the calling tx
    // is later aborted.
    const hybrid: F6AuditPort = {
      ...audit,
      emit: async (entry) => {
        // Both probe + downloaded emits go through the standalone
        // tx so a parent-tx rollback (rare on read-only paths) does
        // not lose the audit row. Aligns with the audit-trust
        // invariants from F4/F5/F7.
        return standalone.emitStandalone(entry as F6AuditEntry<F6AuditEventType>);
      },
    };
    const outcome = await generateErrorCsvSignedUrl(
      {
        tenantId: asTenantId(input.tenantSlug),
        actorUserId: input.actorUserId,
        recordId: asCsvImportRecordId(input.recordId),
        sourceIp: input.sourceIp,
      },
      {
        csvImportRecordsRepo: repo,
        csvImportRecordsAdminRepo: adminRepo,
        errorCsvStore: vercelBlobErrorCsvStore,
        audit: hybrid,
        logger,
        onDownloadSuccess: (tenantId) =>
          eventcreateMetrics.csvErrorCsvDownloaded(tenantId),
      },
    );
    if (!outcome.ok) {
      // The use-case is typed `Promise<Result<…, never>>` so this is unreachable;
      // throw to surface the unexpected type-system violation visibly.
      throw new Error('runGenerateErrorCsvSignedUrl: unreachable err branch');
    }
    return outcome.value;
  });
}

// ---------------------------------------------------------------------------
// F6.1 Phase 5 US5 — runSweepExpiredErrorCsvBlobs wrapper (T049)
// ---------------------------------------------------------------------------

export interface RunSweepExpiredErrorCsvBlobsInput {
  readonly limit?: number;
}

export async function runSweepExpiredErrorCsvBlobs(
  input: RunSweepExpiredErrorCsvBlobsInput,
): Promise<SweepExpiredErrorCsvBlobsOutput> {
  const adminRepo = makeDrizzleCsvImportRecordsAdminRepository();
  const outcome = await sweepExpiredErrorCsvBlobs(input, {
    csvImportRecordsAdminRepo: adminRepo,
    errorCsvStore: vercelBlobErrorCsvStore,
    withTenantScope: async (tenantId, fn) => {
      return runInTenant(asTenantContext(tenantId), async (tx) => {
        const repo = makeDrizzleCsvImportRecordsRepository(tx);
        return fn(repo);
      });
    },
    logger,
  });
  if (!outcome.ok) {
    throw new Error('runSweepExpiredErrorCsvBlobs: unreachable err branch');
  }
  return outcome.value;
}

// Suppress unused-import lint when no consumer triggers the type-only
// imports above (TenantTx, EventId, CsvImportRecordId are used only as
// type re-exports in some compile paths).
type _UnusedTypes = TenantTx | EventId | CsvImportRecordId;
const _unused: _UnusedTypes | undefined = undefined;
void _unused;

/**
 * F6.1 (Feature 013 · T023) — Single-query event fetch by id WITHOUT
 * tenant filter, then check tenant ownership in app code. Both
 * `not_found` and `wrong_tenant` paths execute IDENTICAL DB work so
 * wall-clock variance is naturally bounded — closes critique E8
 * (timing-attack enumeration).
 *
 * Uses the root `db` instance (NOT `runInTenant`) so the query bypasses
 * RLS — we genuinely need to read events from OTHER tenants to detect
 * cross-tenant probes. The default Neon role (`neondb_owner`) has
 * `rolbypassrls=true`, so this works without an explicit role switch.
 *
 * The cross-tenant audit emit is left to the caller (route handler)
 * because the caller owns the audit envelope (sourceIp, requestId, etc.).
 */
export async function lookupEventByIdTimingSafe(
  tenantSlug: string,
  eventId: string,
): Promise<EventLookupResult> {
  const result = await db.execute<EventLookupRow>(sql`
    SELECT tenant_id, external_id, name, start_date, category
    FROM events
    WHERE event_id = ${eventId}::uuid
    LIMIT 1
  `);
  const rows = result as unknown as ReadonlyArray<EventLookupRow>;
  if (rows.length === 0) {
    return { kind: 'not_found' };
  }
  const row = rows[0]!;
  if (row.tenant_id !== tenantSlug) {
    return { kind: 'wrong_tenant', ownerTenantSlug: row.tenant_id };
  }
  return {
    kind: 'found',
    event: {
      eventId,
      externalId: row.external_id,
      name: row.name,
      startDate: new Date(row.start_date),
      category: row.category,
    },
  };
}
