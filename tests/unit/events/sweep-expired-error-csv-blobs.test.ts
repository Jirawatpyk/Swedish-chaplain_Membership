/**
 * CR-2 (R1 — pr-test-analyzer) — unit tests for
 * `sweepExpiredErrorCsvBlobs` covering the documented failure-mode
 * branches that integration tests cannot reach cheaply:
 *
 *   - Happy path: 2 expired rows → both deleted + cleared
 *   - Scan failure → `kind:'scan_failed'` + ERROR log + onScanFailed metric
 *   - Blob delete `blob_not_found` → idempotent success (still counted as swept)
 *   - Blob delete `storage_error` → skipped + WARN log + retry on next run
 *   - clearErrorCsvBlob err result → skipped + onSweepClearFailed metric
 *   - withTenantScope throws → skipped + onSweepClearFailed metric
 *   - Mixed run: some succeed, some skip → counts correct
 *
 * Constitution Principle II — 100% branch coverage on the cron failure
 * paths (silent-failure-hunter I-1, I-6 + spec AS-US5-11).
 */
import { describe, expect, it, vi } from 'vitest';
import { sweepExpiredErrorCsvBlobs } from '@/modules/events/application/use-cases/sweep-expired-error-csv-blobs';
import type {
  SweepExpiredErrorCsvBlobsDeps,
} from '@/modules/events/application/use-cases/sweep-expired-error-csv-blobs';
import type { TenantId } from '@/modules/members';
import type { CsvImportRecordId } from '@/modules/events/domain/csv-import-record-id';
import { err, ok } from '@/lib/result';

const tenantA = 'tenant-a-uuid' as unknown as TenantId;
const tenantB = 'tenant-b-uuid' as unknown as TenantId;
const recordA = '11111111-1111-4111-8111-aaaaaaaaaaaa' as unknown as CsvImportRecordId;
const recordB = '22222222-2222-4222-8222-bbbbbbbbbbbb' as unknown as CsvImportRecordId;

function makeDeps(
  over: Partial<SweepExpiredErrorCsvBlobsDeps> = {},
): SweepExpiredErrorCsvBlobsDeps {
  return {
    csvImportRecordsAdminRepo: {
      findByIdAcrossTenants: vi.fn(),
      listExpiredErrorCsvBlobsAllTenants: vi.fn().mockResolvedValue(ok([])),
    } as unknown as SweepExpiredErrorCsvBlobsDeps['csvImportRecordsAdminRepo'],
    errorCsvStore: {
      put: vi.fn(),
      generateSignedUrl: vi.fn(),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as SweepExpiredErrorCsvBlobsDeps['errorCsvStore'],
    withTenantScope: vi.fn(async (_tenantId, fn) =>
      fn({
        clearErrorCsvBlob: vi.fn().mockResolvedValue(ok(undefined)),
      } as unknown as Parameters<typeof fn>[0]),
    ),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSweepClearFailed: vi.fn(),
    onScanFailed: vi.fn(),
    ...over,
  };
}

describe('sweepExpiredErrorCsvBlobs', () => {
  it('happy path: 2 expired rows → both swept', async () => {
    const clearedTenants: TenantId[] = [];
    const deps = makeDeps({
      withTenantScope: vi.fn(async (tenantId, fn) => {
        clearedTenants.push(tenantId);
        return fn({
          clearErrorCsvBlob: vi.fn().mockResolvedValue(ok(undefined)),
        } as unknown as Parameters<typeof fn>[0]);
      }),
    });
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
        {
          recordId: recordB,
          tenantId: tenantB,
          errorCsvBlobUrl: 'https://blob/b.csv',
          errorCsvExpiresAt: new Date('2026-04-02T00:00:00Z'),
        },
      ]),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('ok');
    if (result.value.kind !== 'ok') return;
    expect(result.value.candidatesScanned).toBe(2);
    expect(result.value.sweptCount).toBe(2);
    expect(result.value.skippedCount).toBe(0);
    expect(clearedTenants).toEqual([tenantA, tenantB]);
  });

  it('scan failure → kind:"scan_failed" + onScanFailed + ERROR log', async () => {
    const deps = makeDeps();
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(err({ kind: 'db_error' as const, message: 'pool exhausted' }));

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('scan_failed');
    expect(deps.onScanFailed).toHaveBeenCalledTimes(1);
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_error_csv_sweep_scan_failed' }),
      expect.any(String),
    );
  });

  it('blob delete blob_not_found → idempotent success (counted as swept)', async () => {
    const deps = makeDeps();
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]),
    );
    (deps.errorCsvStore.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'blob_not_found' as const }),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.sweptCount).toBe(1);
    expect(result.value.skippedCount).toBe(0);
  });

  it('blob delete storage_error → row skipped + WARN log + retry next run', async () => {
    const deps = makeDeps();
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]),
    );
    (deps.errorCsvStore.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
      err({ kind: 'storage_error' as const, message: 'Vercel Blob 503' }),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.sweptCount).toBe(0);
    expect(result.value.skippedCount).toBe(1);
    expect(deps.logger?.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_error_csv_sweep_blob_delete_failed',
      }),
      expect.any(String),
    );
    // onSweepClearFailed is NOT bumped — the failure was at the BLOB
    // step, not the DB clear step.
    expect(deps.onSweepClearFailed).not.toHaveBeenCalled();
  });

  it('clearErrorCsvBlob err → skipped + onSweepClearFailed metric + ERROR log', async () => {
    const clearMock = vi.fn().mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'RLS denied' }),
    );
    const deps = makeDeps({
      withTenantScope: vi.fn(async (_t, fn) =>
        fn({ clearErrorCsvBlob: clearMock } as unknown as Parameters<typeof fn>[0]),
      ),
    });
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.sweptCount).toBe(0);
    expect(result.value.skippedCount).toBe(1);
    expect(deps.onSweepClearFailed).toHaveBeenCalledTimes(1);
    expect(deps.onSweepClearFailed).toHaveBeenCalledWith(tenantA);
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_error_csv_sweep_clear_failed' }),
      expect.any(String),
    );
  });

  it('withTenantScope throws → skipped + onSweepClearFailed metric', async () => {
    const deps = makeDeps({
      withTenantScope: vi.fn(async () => {
        throw new Error('runInTenant connection refused');
      }),
    });
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.sweptCount).toBe(0);
    expect(result.value.skippedCount).toBe(1);
    expect(deps.onSweepClearFailed).toHaveBeenCalledTimes(1);
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_error_csv_sweep_clear_threw' }),
      expect.any(String),
    );
  });

  it('mixed: one swept + one skipped — counts correct', async () => {
    const clear = vi
      .fn()
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err({ kind: 'db_error' as const, message: '...' }));
    const deps = makeDeps({
      withTenantScope: vi.fn(async (_t, fn) =>
        fn({ clearErrorCsvBlob: clear } as unknown as Parameters<typeof fn>[0]),
      ),
    });
    (
      deps.csvImportRecordsAdminRepo
        .listExpiredErrorCsvBlobsAllTenants as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      ok([
        {
          recordId: recordA,
          tenantId: tenantA,
          errorCsvBlobUrl: 'https://blob/a.csv',
          errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
        },
        {
          recordId: recordB,
          tenantId: tenantB,
          errorCsvBlobUrl: 'https://blob/b.csv',
          errorCsvExpiresAt: new Date('2026-04-02T00:00:00Z'),
        },
      ]),
    );

    const result = await sweepExpiredErrorCsvBlobs({}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.sweptCount).toBe(1);
    expect(result.value.skippedCount).toBe(1);
    expect(deps.onSweepClearFailed).toHaveBeenCalledTimes(1);
    expect(deps.onSweepClearFailed).toHaveBeenCalledWith(tenantB);
  });

  it('limit clamp: input.limit > 1000 → capped to 1000', async () => {
    const deps = makeDeps();
    await sweepExpiredErrorCsvBlobs({ limit: 5000 }, deps);
    expect(
      deps.csvImportRecordsAdminRepo.listExpiredErrorCsvBlobsAllTenants,
    ).toHaveBeenCalledWith(expect.any(Date), 1000);
  });

  it('limit floor: input.limit = 0 → bumped to 1', async () => {
    const deps = makeDeps();
    await sweepExpiredErrorCsvBlobs({ limit: 0 }, deps);
    expect(
      deps.csvImportRecordsAdminRepo.listExpiredErrorCsvBlobsAllTenants,
    ).toHaveBeenCalledWith(expect.any(Date), 1);
  });

  it('clock injection: cutoff matches injected clock', async () => {
    const fixed = new Date('2026-05-01T08:00:00Z');
    const deps = makeDeps();
    await sweepExpiredErrorCsvBlobs({ clock: () => fixed }, deps);
    expect(
      deps.csvImportRecordsAdminRepo.listExpiredErrorCsvBlobsAllTenants,
    ).toHaveBeenCalledWith(fixed, 100);
  });
});
