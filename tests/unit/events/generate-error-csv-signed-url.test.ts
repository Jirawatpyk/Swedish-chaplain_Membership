/**
 * CR-1 (R1 — pr-test-analyzer) — unit tests for
 * `generateErrorCsvSignedUrl` covering the 7+ branches that integration
 * tests cannot reach cheaply:
 *
 *   - Happy path: signed URL + audit emit + onDownloadSuccess
 *   - Strict-audit invariant: audit-emit failure → `signing_failure`
 *     (no URL returned to caller)
 *   - `errorCsvBlobUrl=null` (rowsFailed=0 import) → `not_found`
 *   - `errorCsvExpiresAt` in the past → `expired`
 *   - signing failure (Vercel Blob outage) → `signing_failure` + pino
 *     log + NO audit emit
 *   - `findById` `db_error` → falls through to probe check (CR-7) →
 *     `not_found` regardless
 *   - Cross-tenant probe: `findById` not_found + admin probe hits a
 *     different tenant → `not_found` + critical-severity probe audit
 *   - Cross-tenant probe audit-emit failure → still 404 (fail-open)
 *     + pino warn capture
 *   - Cross-tenant probe runs on `db_error` branch (CR-7 fix)
 *
 * Constitution Principle II — 100% branch coverage on the strict-audit
 * gate + cross-tenant probe handling per spec FR-021 + FR-024.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateErrorCsvSignedUrl } from '@/modules/events/application/use-cases/generate-error-csv-signed-url';
import type {
  GenerateErrorCsvSignedUrlDeps,
  GenerateErrorCsvSignedUrlInput,
} from '@/modules/events/application/use-cases/generate-error-csv-signed-url';
import { asCsvImportRecordId } from '@/modules/events/domain/csv-import-record-id';
import { err, ok } from '@/lib/result';

const tenantA = 'tenant-a-uuid' as unknown as GenerateErrorCsvSignedUrlInput['tenantId'];
const tenantB = 'tenant-b-uuid' as unknown as GenerateErrorCsvSignedUrlInput['tenantId'];
const actorUserId = '00000000-0000-4000-8000-000000000001' as unknown as GenerateErrorCsvSignedUrlInput['actorUserId'];
const recordId = asCsvImportRecordId('11111111-1111-4111-8111-111111111111');

function fixedClock(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

function makeDeps(
  overrides: Partial<GenerateErrorCsvSignedUrlDeps> = {},
): GenerateErrorCsvSignedUrlDeps {
  const noopLogger = { error: vi.fn() };
  const noopMetric = vi.fn();
  return {
    csvImportRecordsRepo: {
      insert: vi.fn(),
      updateOutcome: vi.fn(),
      setErrorCsvBlob: vi.fn(),
      findByFingerprintAcrossEvents: vi.fn(),
      listByTenant: vi.fn(),
      findById: vi.fn().mockResolvedValue(err({ kind: 'not_found' as const })),
      clearErrorCsvBlob: vi.fn(),
    } as unknown as GenerateErrorCsvSignedUrlDeps['csvImportRecordsRepo'],
    csvImportRecordsAdminRepo: {
      findByIdAcrossTenants: vi.fn().mockResolvedValue(ok(null)),
      listExpiredErrorCsvBlobsAllTenants: vi.fn(),
    } as unknown as GenerateErrorCsvSignedUrlDeps['csvImportRecordsAdminRepo'],
    errorCsvStore: {
      put: vi.fn(),
      generateSignedUrl: vi.fn(),
      delete: vi.fn(),
    } as unknown as GenerateErrorCsvSignedUrlDeps['errorCsvStore'],
    audit: {
      emit: vi.fn().mockResolvedValue(ok('audit-uuid')),
      emitRolledBack: vi.fn(),
      emitStandalone: vi.fn(),
    } as unknown as GenerateErrorCsvSignedUrlDeps['audit'],
    logger: noopLogger,
    onDownloadSuccess: noopMetric,
    clock: fixedClock('2026-05-15T10:00:00Z'),
    ...overrides,
  };
}

const baseInput: GenerateErrorCsvSignedUrlInput = {
  tenantId: tenantA,
  actorUserId,
  recordId,
  sourceIp: '203.0.113.10',
};

function makeRecord(over: {
  readonly errorCsvBlobUrl?: string | null;
  readonly errorCsvExpiresAt?: Date | null;
  readonly tenantId?: GenerateErrorCsvSignedUrlInput['tenantId'];
}) {
  return {
    recordId,
    tenantId: over.tenantId ?? tenantA,
    actorUserId,
    eventId: 'event-uuid' as unknown as GenerateErrorCsvSignedUrlInput['recordId'],
    uploadedAt: new Date('2026-05-10T09:00:00Z'),
    sourceFormat: 'eventcreate_csv' as const,
    originalFilename: 'attendees.csv',
    originalSizeBytes: 1024,
    rowsTotal: 5,
    rowsProcessed: 4,
    rowsAlreadyImported: 0,
    rowsSkipped: 0,
    rowsFailed: 1,
    outcome: 'completed' as const,
    durationMs: 1234,
    errorCsvBlobUrl: over.errorCsvBlobUrl ?? null,
    errorCsvExpiresAt: over.errorCsvExpiresAt ?? null,
  };
}

describe('generateErrorCsvSignedUrl', () => {
  it('happy path: emits audit + bumps metric + returns signed URL', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: 'https://blob/foo.csv',
          errorCsvExpiresAt: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
    );
    (
      deps.errorCsvStore.generateSignedUrl as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok({
        signedUrl: 'https://blob/foo.csv?sig=abc',
        expiresAt: new Date('2026-05-15T10:15:00Z'),
      }),
    );

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('success');
    if (result.value.kind !== 'success') return;
    expect(result.value.signedUrl).toBe('https://blob/foo.csv?sig=abc');
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    expect(deps.onDownloadSuccess).toHaveBeenCalledTimes(1);
    expect(deps.onDownloadSuccess).toHaveBeenCalledWith(tenantA);
  });

  it('strict-audit invariant: audit emit failure → signing_failure (no URL returned)', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: 'https://blob/foo.csv',
          errorCsvExpiresAt: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
    );
    (
      deps.errorCsvStore.generateSignedUrl as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok({
        signedUrl: 'https://blob/foo.csv?sig=abc',
        expiresAt: new Date('2026-05-15T10:15:00Z'),
      }),
    );
    (deps.audit.emit as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'db_error' as const, message: 'audit store outage' }),
    );

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('signing_failure');
    expect(deps.onDownloadSuccess).not.toHaveBeenCalled();
    // R2-I-9 (R2 — pr-test-analyzer): also assert the structured
    // `f6_error_csv_audit_emit_blocking_failure` pino log fired —
    // a regression to a silent return would otherwise leave SREs
    // blind to the strict-audit gate firing.
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_error_csv_audit_emit_blocking_failure',
      }),
      expect.any(String),
    );
  });

  it('not_found when errorCsvBlobUrl is null (rowsFailed=0 import)', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: null,
          errorCsvExpiresAt: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
    );
    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.errorCsvStore.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('expired when errorCsvExpiresAt is in the past', async () => {
    const deps = makeDeps({ clock: fixedClock('2026-05-15T10:00:00Z') });
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: 'https://blob/foo.csv',
          errorCsvExpiresAt: new Date('2026-04-30T10:00:00Z'),
        }),
      ),
    );
    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('expired');
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('boundary: expiresAt === now() is treated as expired (<= comparator)', async () => {
    const now = new Date('2026-05-15T10:00:00Z');
    const deps = makeDeps({ clock: () => now });
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: 'https://blob/foo.csv',
          errorCsvExpiresAt: new Date(now.getTime()),
        }),
      ),
    );
    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('expired');
  });

  it('signing failure → signing_failure + pino log + NO audit emit', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(
        makeRecord({
          errorCsvBlobUrl: 'https://blob/foo.csv',
          errorCsvExpiresAt: new Date('2026-06-15T10:00:00Z'),
        }),
      ),
    );
    (
      deps.errorCsvStore.generateSignedUrl as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      err({ kind: 'storage_error' as const, message: 'Vercel Blob 503' }),
    );

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('signing_failure');
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_error_csv_signing_failure' }),
      expect.any(String),
    );
  });

  it('CR-7: findById db_error falls through to probe check (still 404)', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'connection reset' }),
    );
    // Admin probe shows the row exists in tenant B — should fire probe audit.
    (
      deps.csvImportRecordsAdminRepo.findByIdAcrossTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ok({ tenantId: tenantB }));

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'csv_import_cross_tenant_probe',
      }),
    );
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_error_csv_findbyid_db_error' }),
      expect.any(String),
    );
    // R2-I-10 (R2 — pr-test-analyzer): db_error branch MUST emit probe
    // at `critical` severity, same as the not_found-path test. A
    // regression flipping severity ONLY on the db_error path would
    // otherwise slip through CI.
    const probeCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].eventType === 'csv_import_cross_tenant_probe',
    );
    expect(probeCall?.[0].payload.severity).toBe('critical');
    expect(probeCall?.[0].payload.probedId).toBe(recordId);
    expect(probeCall?.[0].payload.probeSurface).toBe('error_csv_record_id');
  });

  it('cross-tenant probe: emits critical-severity audit, returns 404', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'not_found' as const }),
    );
    (
      deps.csvImportRecordsAdminRepo.findByIdAcrossTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ok({ tenantId: tenantB }));

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    const probeCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].eventType === 'csv_import_cross_tenant_probe',
    );
    expect(probeCall).toBeDefined();
    expect(probeCall?.[0].payload.severity).toBe('critical');
    expect(probeCall?.[0].payload.probedId).toBe(recordId);
    expect(probeCall?.[0].payload.probeSurface).toBe('error_csv_record_id');
  });

  it('cross-tenant probe audit failure → still 404 (fail-open) + pino log', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'not_found' as const }),
    );
    (
      deps.csvImportRecordsAdminRepo.findByIdAcrossTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ok({ tenantId: tenantB }));
    (deps.audit.emit as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'db_error' as const, message: 'probe-audit outage' }),
    );

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_error_csv_cross_tenant_probe_audit_emit_failed',
      }),
      expect.any(String),
    );
  });

  it('probe returns null (truly missing) → no probe audit', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'not_found' as const }),
    );
    (
      deps.csvImportRecordsAdminRepo.findByIdAcrossTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ok(null));

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('probe returns own-tenant row (race: deleted between findById and probe) → no probe audit', async () => {
    const deps = makeDeps();
    (deps.csvImportRecordsRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'not_found' as const }),
    );
    (
      deps.csvImportRecordsAdminRepo.findByIdAcrossTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(ok({ tenantId: tenantA }));

    const result = await generateErrorCsvSignedUrl(baseInput, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('not_found');
    // Same-tenant row → probe condition `probe.value.tenantId !== input.tenantId` is false → no emit.
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });
});
