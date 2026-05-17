/**
 * Phase B B11 — Contract test: POST /api/internal/retention/sweep-error-csv-blobs
 *
 * Verifies the B4 GET → POST switch + bearer auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      features: { ...actual.env.features, f6EventCreate: true },
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

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  runSweepExpiredErrorCsvBlobsMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Phase B B11 — POST /api/internal/retention/sweep-error-csv-blobs', () => {
  vi.setConfig({ testTimeout: 30_000 });

  it('returns 401 when gate rejects', async () => {
    gateCronBearerOrRespondMock.mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(runSweepExpiredErrorCsvBlobsMock).not.toHaveBeenCalled();
  });

  it('returns 500 on scan_failed', async () => {
    runSweepExpiredErrorCsvBlobsMock.mockResolvedValue({
      kind: 'scan_failed',
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it('returns 200 on completed (non-scan_failed kind)', async () => {
    runSweepExpiredErrorCsvBlobsMock.mockResolvedValue({
      kind: 'completed',
      candidatesScanned: 5,
      sweptCount: 2,
      skippedCount: 0,
      cutoff: new Date('2026-01-01T00:00:00Z'),
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});
