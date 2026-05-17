/**
 * Phase H4.3 — Isolated killswitch test for the F6 error-CSV blob
 * sweep cron. Same isolation rationale as the idempotency-sweep
 * killswitch sibling.
 *
 * Note: this route does NOT explicitly gate on `f6EventCreate` (the
 * sweep is safe to run when F6 is off — it just cleans up stale Blob
 * objects + DB columns). So the killswitch test here verifies that the
 * route accepts the request and runs the sweep regardless of the flag.
 * Documents the deliberate divergence from pseudonymise + idempotency
 * sweeps which gate on the flag.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const gateCronBearerOrRespondMock = vi.fn();
const runSweepExpiredErrorCsvBlobsMock = vi.fn();

vi.mock('@/lib/cron-auth', () => ({
  gateCronBearerOrRespond: (...args: unknown[]) =>
    gateCronBearerOrRespondMock(...args),
}));

vi.mock('@/lib/events-csv-import-deps', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/events-csv-import-deps')
  >('@/lib/events-csv-import-deps');
  return {
    ...actual,
    runSweepExpiredErrorCsvBlobs: (...args: unknown[]) =>
      runSweepExpiredErrorCsvBlobsMock(...args),
  };
});

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f6EventCreate: false },
      tenant: { slug: 'test-swecham' },
    },
  };
});

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/internal/retention/sweep-error-csv-blobs',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/internal/retention/sweep-error-csv-blobs/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeAll(async () => {
  await loadRoute();
});

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  runSweepExpiredErrorCsvBlobsMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('H4.3 — sweep-error-csv-blobs killswitch isolation', () => {
  vi.setConfig({ testTimeout: 90_000 });

  it('runs the sweep regardless of F6 flag state (deliberate divergence)', async () => {
    // The sweep is a Blob-storage cleanup that's safe to run when F6
    // is dark; it doesn't touch F6 ingest paths. Cleanup of stale
    // Blob TTL records is independent of whether the feature is live.
    runSweepExpiredErrorCsvBlobsMock.mockResolvedValue({
      kind: 'completed',
      candidatesScanned: 0,
      sweptCount: 0,
      skippedCount: 0,
      cutoff: new Date('2026-01-01T00:00:00Z'),
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // Use-case IS dispatched even when flag is off — sweep is
    // feature-flag-agnostic.
    expect(runSweepExpiredErrorCsvBlobsMock).toHaveBeenCalled();
  });
});
