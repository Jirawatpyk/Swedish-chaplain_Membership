/**
 * S1-P1-15 — the process-export-jobs cron MUST emit `data_export_expired` when
 * it TTL-sweeps a ready/delivered export. The event type was declared (5y
 * retention) + counted in SC-004 audit completeness but never emitted, so a
 * compliance auditor saw exports created/delivered yet never expired. This pins
 * the emit so a regression that drops it fails CI.
 *
 * Mirrors `snapshot-refresh-tenant-guard.test.ts`: env + cron-auth + module
 * deps are mocked so the test isolates the sweep→audit branch.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f9Dashboard: true },
    tenant: { slug: 'tenanta' },
  },
}));

const gateMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/cron-auth', () => ({ gateCronBearerOrRespond: gateMock }));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenanta' }),
}));

// runInTenant just runs the callback with a fake tx and returns its result.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('@/lib/metrics', () => ({
  insightsMetrics: {
    auditEmitFailed: vi.fn(),
    exportJobReclaimed: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'Error' }));

vi.mock('@/modules/insights', () => ({
  processExportJob: vi.fn(),
  STUCK_PROCESSING_TIMEOUT_MS: 600000,
  // All F9 events are 5-year retention; the route now reads this single source
  // of truth instead of hardcoding `5` (F9 #12).
  f9RetentionFor: () => 5,
}));

const auditRecordMock = vi.hoisted(() => vi.fn(async (_event?: unknown) => undefined));
const repoMock = vi.hoisted(() => ({
  listRequestedIds: vi.fn(async () => []),
  listStuckProcessing: vi.fn(
    async (): Promise<
      Array<{ jobId: string; kind: string; subjectMemberId: string | null }>
    > => [],
  ),
  listSweepable: vi.fn(async () => [{ jobId: 'job-expired-1', blobKey: null }]),
  markExpiredInTx: vi.fn(async () => true),
  reclaimStuckInTx: vi.fn(async () => false),
  // P2 Wave-0 — cron now runs a retention purge after the TTL sweep.
  purgeRetiredInTx: vi.fn(async () => 0),
}));
vi.mock('@/modules/insights/infrastructure/repos/drizzle-export-job-repo', () => ({
  makeDrizzleExportJobRepo: () => repoMock,
}));
vi.mock('@/modules/insights/infrastructure/process-export-job-deps', () => ({
  makeProcessExportJobDeps: () => ({
    blob: { delete: vi.fn(async () => undefined) },
    audit: { record: auditRecordMock },
  }),
}));

import { POST } from '@/app/api/cron/insights/process-export-jobs/route';

function makeRequest(): NextRequest {
  return {
    headers: { get: () => 'Bearer test-secret-32-bytes-long-aaaaaa' },
  } as unknown as NextRequest;
}

describe('process-export-jobs cron — data_export_expired emit (S1-P1-15)', () => {
  beforeEach(() => {
    auditRecordMock.mockClear();
  });

  it('emits data_export_expired for each swept job (retention from f9RetentionFor, not a hardcoded 5)', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data_export_expired',
        actorUserId: 'system:cron',
        retentionYears: 5,
        payload: { job_id: 'job-expired-1' },
      }),
    );
  });
});

describe('process-export-jobs cron — stuck-reclaim emits data_export_failed for GDPR (F9 #3)', () => {
  beforeEach(() => {
    auditRecordMock.mockClear();
    // Isolate the reclaim branch (no sweep emits in these cases).
    repoMock.listSweepable.mockResolvedValue([]);
    repoMock.listStuckProcessing.mockResolvedValue([]);
    repoMock.reclaimStuckInTx.mockResolvedValue(false);
  });

  it('emits data_export_failed (with subject_member_id) when a stuck gdpr_member_archive is reclaimed', async () => {
    repoMock.listStuckProcessing.mockResolvedValueOnce([
      { jobId: 'stuck-gdpr-1', kind: 'gdpr_member_archive', subjectMemberId: 'mem-9' },
    ]);
    repoMock.reclaimStuckInTx.mockResolvedValueOnce(true);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data_export_failed',
        actorUserId: 'system:cron',
        retentionYears: 5,
        // M-1: subject scoped so the member's failed export joins their Art.15 subset.
        payload: { job_id: 'stuck-gdpr-1', error_code: 'worker_timeout', subject_member_id: 'mem-9' },
      }),
    );
  });

  it('does NOT emit data_export_failed for a non-GDPR (directory) reclaim', async () => {
    repoMock.listStuckProcessing.mockResolvedValueOnce([
      { jobId: 'stuck-ebook-1', kind: 'directory_ebook', subjectMemberId: null },
    ]);
    repoMock.reclaimStuckInTx.mockResolvedValueOnce(true);

    await POST(makeRequest());
    const failedEmit = auditRecordMock.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'data_export_failed',
    );
    expect(failedEmit).toBeUndefined();
  });

  it('does NOT emit when the reclaim loses the race (reclaimStuckInTx → false)', async () => {
    repoMock.listStuckProcessing.mockResolvedValueOnce([
      { jobId: 'stuck-gdpr-2', kind: 'gdpr_member_archive', subjectMemberId: 'mem-2' },
    ]);
    repoMock.reclaimStuckInTx.mockResolvedValueOnce(false);

    await POST(makeRequest());
    const failedEmit = auditRecordMock.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'data_export_failed',
    );
    expect(failedEmit).toBeUndefined();
  });
});
