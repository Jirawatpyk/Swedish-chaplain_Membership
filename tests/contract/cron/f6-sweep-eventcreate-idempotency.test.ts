/**
 * Phase B B11 — Contract test: POST /api/internal/retention/sweep-eventcreate-idempotency
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const gateCronBearerOrRespondMock = vi.fn();
const sweepStaleIdempotencyReceiptsMock = vi.fn();
const runInTenantMock = vi.fn();

vi.mock('@/lib/cron-auth', () => ({
  gateCronBearerOrRespond: (...args: unknown[]) =>
    gateCronBearerOrRespondMock(...args),
}));

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>(
    '@/modules/events',
  );
  return {
    ...actual,
    sweepStaleIdempotencyReceipts: (...args: unknown[]) =>
      sweepStaleIdempotencyReceiptsMock(...args),
    makeDrizzleIdempotencySweepPort: () => ({}),
  };
});

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    runInTenant: (...args: unknown[]) => runInTenantMock(...args),
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
    'http://localhost/api/internal/retention/sweep-eventcreate-idempotency',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/internal/retention/sweep-eventcreate-idempotency/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  sweepStaleIdempotencyReceiptsMock.mockReset();
  runInTenantMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
  runInTenantMock.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Phase B B11 — POST /api/internal/retention/sweep-eventcreate-idempotency', () => {
  vi.setConfig({ testTimeout: 30_000 });

  it('returns 401 when gate rejects', async () => {
    gateCronBearerOrRespondMock.mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(sweepStaleIdempotencyReceiptsMock).not.toHaveBeenCalled();
  });

  it('returns 200 on happy path', async () => {
    sweepStaleIdempotencyReceiptsMock.mockResolvedValue({
      ok: true,
      value: { rowsScanned: 5, rowsSwept: 1, durationMs: 30 },
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
  });
});
