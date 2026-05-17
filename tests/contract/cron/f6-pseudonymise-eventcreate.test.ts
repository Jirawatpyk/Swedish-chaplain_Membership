/**
 * Phase B B11 — Contract test: POST /api/internal/retention/pseudonymise-eventcreate
 *
 * Wire contract:
 *   - missing/wrong Bearer → 401
 *   - feature flag off → 200 skipped
 *   - missing salt → 500 misconfigured
 *   - per-tenant Result.err → 500 (A3 closure)
 *   - all-success → 200 with perTenant outcomes
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const gateCronBearerOrRespondMock = vi.fn();
const pseudonymiseStaleNonMemberPiiMock = vi.fn();
const makeDepsMock = vi.fn();
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
    pseudonymiseStaleNonMemberPii: (...args: unknown[]) =>
      pseudonymiseStaleNonMemberPiiMock(...args),
    makePseudonymiseStaleNonMemberPiiDeps: (...args: unknown[]) =>
      makeDepsMock(...args),
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
      eventcreate: { piiPseudonymSalt: 'test-salt' },
    },
  };
});

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/internal/retention/pseudonymise-eventcreate',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/internal/retention/pseudonymise-eventcreate/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeEach(() => {
  gateCronBearerOrRespondMock.mockReset();
  pseudonymiseStaleNonMemberPiiMock.mockReset();
  makeDepsMock.mockReset();
  runInTenantMock.mockReset();
  // default: gate passes
  gateCronBearerOrRespondMock.mockResolvedValue(null);
  // default: runInTenant invokes the callback
  runInTenantMock.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
  );
  makeDepsMock.mockReturnValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Phase B B11 — POST /api/internal/retention/pseudonymise-eventcreate', () => {
  vi.setConfig({ testTimeout: 30_000 });

  it('returns 401 envelope when gate rejects', async () => {
    gateCronBearerOrRespondMock.mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(pseudonymiseStaleNonMemberPiiMock).not.toHaveBeenCalled();
  });

  it('returns 200 skipped when feature flag off', async () => {
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
          eventcreate: { piiPseudonymSalt: 'test-salt' },
        },
      };
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['skipped']).toBe('feature_off');
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });

  it('returns 200 with perTenant success on happy path', async () => {
    pseudonymiseStaleNonMemberPiiMock.mockResolvedValue({
      ok: true,
      value: { rowsScanned: 10, rowsPseudonymised: 2, durationMs: 50 },
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    const perTenant = body['perTenant'] as ReadonlyArray<Record<string, unknown>>;
    expect(perTenant.length).toBeGreaterThan(0);
    expect(perTenant[0]?.['outcome']).toBe('success');
  });

  it('R2-I2 F8 convention — returns 200 with per-tenant error in body (NOT 500)', async () => {
    // Per docs/runbooks/cron-jobs.md:327-328 F8 coordinator convention:
    // per-tenant errors degrade to `tenants_failed > 0` in 200; only
    // scan-level errors (auth, env, tenant-list query) return 500.
    // SRE alerting fires via the OTel error counter, not HTTP status.
    pseudonymiseStaleNonMemberPiiMock.mockResolvedValue({
      ok: false,
      error: { kind: 'db_error', message: 'simulated failure' },
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    const perTenant = body['perTenant'] as ReadonlyArray<Record<string, unknown>>;
    expect(perTenant.length).toBeGreaterThan(0);
    expect(perTenant[0]?.['outcome']).toBe('error');
    expect(perTenant[0]?.['message']).toContain('simulated failure');
  });
});
