/**
 * Phase H4.3 — Isolated killswitch test for the F6 idempotency sweep
 * cron. Mirrors `f6-pseudonymise-eventcreate.test.ts` "200 skipped when
 * feature flag off" pattern in its own file (Vitest mock-cache hygiene
 * — see `admin-events-create-killswitch.test.ts` precedent).
 *
 * Verifies: with `FEATURE_F6_EVENTCREATE=false` AND valid Bearer auth,
 * the route returns 200 `{skipped: 'feature_off'}` and the use-case is
 * NEVER dispatched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const gateCronBearerOrRespondMock = vi.fn();
const sweepStaleIdempotencyReceiptsMock = vi.fn();

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
    'http://localhost/api/internal/retention/sweep-eventcreate-idempotency',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/internal/retention/sweep-eventcreate-idempotency/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeAll(async () => {
  await loadRoute();
});

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  sweepStaleIdempotencyReceiptsMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('H4.3 — sweep-eventcreate-idempotency killswitch isolation', () => {
  vi.setConfig({ testTimeout: 90_000 });

  it('returns 200 skipped when FEATURE_F6_EVENTCREATE=false (use-case NOT dispatched)', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['skipped']).toBe('feature_off');
    expect(sweepStaleIdempotencyReceiptsMock).not.toHaveBeenCalled();
  });
});
