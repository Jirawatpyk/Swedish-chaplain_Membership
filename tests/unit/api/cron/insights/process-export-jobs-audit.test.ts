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
}));

const auditRecordMock = vi.hoisted(() => vi.fn(async () => undefined));
const repoMock = vi.hoisted(() => ({
  listRequestedIds: vi.fn(async () => []),
  listStuckProcessing: vi.fn(async () => []),
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

  it('emits data_export_expired for each swept job', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data_export_expired',
        actorUserId: 'system:cron',
        payload: { job_id: 'job-expired-1' },
      }),
    );
  });
});
