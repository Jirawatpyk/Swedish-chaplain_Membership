/**
 * Phase B B11 — Contract test: POST /api/internal/observability/recompute-match-rate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const gateCronBearerOrRespondMock = vi.fn();

vi.mock('@/lib/cron-auth', () => ({
  gateCronBearerOrRespond: (...args: unknown[]) =>
    gateCronBearerOrRespondMock(...args),
}));

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
    'http://localhost/api/internal/observability/recompute-match-rate',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/internal/observability/recompute-match-rate/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Phase B B11 — POST /api/internal/observability/recompute-match-rate', () => {
  vi.setConfig({ testTimeout: 30_000 });

  it('returns 401 when gate rejects', async () => {
    gateCronBearerOrRespondMock.mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 200 when feature flag off (no DB hit)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
      return {
        ...actual,
        env: {
          ...actual.env,
          features: { ...actual.env.features, f6EventCreate: false },
          tenant: { slug: 'test-swecham' },
        },
      };
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });
});
