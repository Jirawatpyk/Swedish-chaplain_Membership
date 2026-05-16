/**
 * T041 (F6.1 · Feature 013 — Phase 5 US5) — `generateErrorCsvSignedUrl`
 * Application use-case.
 *
 * Backs the `GET /api/admin/events/import/{recordId}/error-csv` route
 * (T043). Looks up the import record by `(tenantId, recordId)`, verifies
 * the blob URL is still present + within the 30-day TTL, signs a
 * 15-minute Vercel Blob URL, and emits the
 * `csv_import_error_csv_downloaded` audit BEFORE returning the URL.
 *
 * Strict-audit invariant (per `contracts/error-csv-signed-url-api.md`):
 *   - Audit emit on the SUCCESS path is mandatory. If the audit fails,
 *     the route returns 500 and NO signed URL is issued (the caller can
 *     re-click; the next attempt may succeed).
 *   - Signing failure (Vercel Blob unavailable) → 500 + pino
 *     `f6_error_csv_signing_failure` log emit; NO audit emit (the audit
 *     is a "successful PII access" event and is intentionally absent
 *     when no access happened).
 *
 * Cross-tenant probe (Constitution Principle I clause 4):
 *   - When the tenant-scoped `findById` returns `not_found` AND the
 *     admin-bypass `findByIdAcrossTenants` shows the recordId DOES
 *     exist in a different tenant, emit `csv_import_cross_tenant_probe`
 *     audit at `critical` severity. The actor still gets 404.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import { ok } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { CsvImportRecordId } from '../../domain/csv-import-record-id';
import type {
  CsvImportRecordsRepository,
  CsvImportRecordsAdminRepository,
} from '../ports/csv-import-records-repo';
import type {
  ErrorCsvStore,
  ErrorCsvStoreError,
} from '../ports/error-csv-store';
import type { F6AuditPort } from '../ports/audit-port';

export interface GenerateErrorCsvSignedUrlInput {
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  readonly recordId: CsvImportRecordId;
  /** First hop from X-Forwarded-For (route parses, passes through). */
  readonly sourceIp: string;
}

export type GenerateErrorCsvSignedUrlOutcome =
  | {
      readonly kind: 'success';
      readonly signedUrl: string;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'signing_failure'; readonly message: string };

export interface GenerateErrorCsvSignedUrlDeps {
  readonly csvImportRecordsRepo: CsvImportRecordsRepository;
  readonly csvImportRecordsAdminRepo: CsvImportRecordsAdminRepository;
  readonly errorCsvStore: ErrorCsvStore;
  readonly audit: F6AuditPort;
  /**
   * Operational logger for `f6_error_csv_signing_failure` etc. — pino
   * structured log emit (NOT a DB audit). Defaulted to a no-op for
   * tests that don't care about stderr capture.
   */
  readonly logger?: {
    error(meta: Record<string, unknown>, msg: string): void;
  };
  /**
   * T051 (F6.1 Phase 6) — increment the
   * `eventcreate_csv_error_csv_downloaded_total{tenant}` OTel counter
   * on success. Injected so unit tests can assert call counts; route
   * composition wires the production metric.
   */
  readonly onDownloadSuccess?: (tenantId: TenantId) => void;
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => Date;
}

const SIGNED_URL_TTL_SECONDS = 15 * 60;

export async function generateErrorCsvSignedUrl(
  input: GenerateErrorCsvSignedUrlInput,
  deps: GenerateErrorCsvSignedUrlDeps,
): Promise<Result<GenerateErrorCsvSignedUrlOutcome, never>> {
  const now = (): Date => deps.clock?.() ?? new Date();
  const logger = deps.logger;

  // --- Step 1: tenant-scoped lookup -----------------------------------
  const lookup = await deps.csvImportRecordsRepo.findById(
    input.tenantId,
    input.recordId,
  );
  if (lookup.ok) {
    const record = lookup.value;
    // Defensive: the row exists in this tenant but blob was swept or
    // never persisted (rowsFailed=0 imports). Surface as `not_found` —
    // the route maps to the same 404 body as cross-tenant + missing.
    if (record.errorCsvBlobUrl === null) {
      return ok({ kind: 'not_found' });
    }
    if (
      record.errorCsvExpiresAt === null ||
      record.errorCsvExpiresAt.getTime() <= now().getTime()
    ) {
      return ok({ kind: 'expired' });
    }

    // Sign URL
    const signResult = await deps.errorCsvStore.generateSignedUrl({
      blobUrl: record.errorCsvBlobUrl,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
    if (!signResult.ok) {
      logger?.error(
        {
          event: 'f6_error_csv_signing_failure',
          tenantId: input.tenantId,
          recordId: input.recordId,
          actorUserId: input.actorUserId,
          blobUrlExists: true,
          err: errorCsvStoreErrorMessage(signResult.error),
        },
        '[F6.1] error-CSV signed-URL generation failed — Vercel Blob unavailable; admin advised to retry',
      );
      return ok({
        kind: 'signing_failure',
        message: errorCsvStoreErrorMessage(signResult.error),
      });
    }

    // Strict-audit invariant — emit BEFORE returning the URL.
    const downloadedAt = now();
    const auditResult = await deps.audit.emit({
      eventType: 'csv_import_error_csv_downloaded',
      tenantId: input.tenantId,
      actorType: 'admin',
      actorUserId: input.actorUserId,
      occurredAt: downloadedAt,
      summary: `Admin downloaded error CSV for import ${input.recordId}`,
      payload: {
        severity: 'info',
        actorUserId: input.actorUserId,
        recordId: input.recordId,
        downloadedAt,
        sourceIp: input.sourceIp,
      },
    });
    if (!auditResult.ok) {
      // Audit failure on the success path: do NOT return the signed URL
      // (the audit row is a PDPA/GDPR-mandated access trail). Map to
      // signing_failure so the route returns 500 + admin can retry.
      logger?.error(
        {
          event: 'f6_error_csv_audit_emit_blocking_failure',
          tenantId: input.tenantId,
          recordId: input.recordId,
          actorUserId: input.actorUserId,
          auditErrKind: auditResult.error.kind,
        },
        '[F6.1] csv_import_error_csv_downloaded audit emit failed — blocking signed-URL return; admin advised to retry',
      );
      return ok({
        kind: 'signing_failure',
        message: `audit emit failed: ${auditResult.error.kind}`,
      });
    }

    // T051 — increment the per-tenant download counter only AFTER the
    // audit emit succeeds (strict-audit invariant first; the metric
    // mirrors the audit row count).
    deps.onDownloadSuccess?.(input.tenantId);

    return ok({
      kind: 'success',
      signedUrl: signResult.value.signedUrl,
      expiresAt: signResult.value.expiresAt,
    });
  }

  // --- Step 2: tenant-scoped lookup returned not_found OR db_error -----
  if (lookup.error.kind === 'db_error') {
    logger?.error(
      {
        event: 'f6_error_csv_findbyid_db_error',
        tenantId: input.tenantId,
        recordId: input.recordId,
        err: lookup.error.message,
      },
      '[F6.1] findById DB error — failing closed with not_found',
    );
    return ok({ kind: 'not_found' });
  }

  // --- Step 3: cross-tenant probe detection ---------------------------
  const probe = await deps.csvImportRecordsAdminRepo.findByIdAcrossTenants(
    input.recordId,
  );
  if (probe.ok && probe.value !== null && probe.value.tenantId !== input.tenantId) {
    // Constitution Principle I clause 4 — HIGH-severity probe event.
    // Fail-open on emit (logger captures); 404 is returned regardless.
    const probedAt = now();
    const probeAudit = await deps.audit.emit({
      eventType: 'csv_import_cross_tenant_probe',
      tenantId: input.tenantId,
      actorType: 'admin',
      actorUserId: input.actorUserId,
      occurredAt: probedAt,
      summary: `Cross-tenant CSV import record probe (recordId=${input.recordId}) by actor in tenant ${input.tenantId}`,
      payload: {
        severity: 'critical',
        actorUserId: input.actorUserId,
        probedId: input.recordId,
        probeSurface: 'error_csv_record_id',
        sourceIp: input.sourceIp,
        probedAt,
      },
    });
    if (!probeAudit.ok) {
      logger?.error(
        {
          event: 'f6_error_csv_cross_tenant_probe_audit_emit_failed',
          tenantId: input.tenantId,
          probedRecordId: input.recordId,
          auditErrKind: probeAudit.error.kind,
        },
        '[F6.1] csv_import_cross_tenant_probe audit emit failed — security forensic trail at risk; actor still receives 404',
      );
    }
  }

  // 404 to actor regardless of cross-tenant outcome.
  return ok({ kind: 'not_found' });
}

function errorCsvStoreErrorMessage(e: ErrorCsvStoreError): string {
  if (e.kind === 'storage_error') return e.message;
  return e.kind;
}
