/**
 * F8 Phase 4 Wave I5 / T103 spec — daily reminder dispatch coordinator route.
 *
 * Test scope: Bearer auth, kill-switch, fan-out summary aggregation,
 * audit emit, error isolation per fetched tenant.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const BASE_URL = 'http://localhost:3100';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
    tenant: { slug: 'tenanta' },
    app: { baseUrl: 'http://localhost:3100' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: 'tenanta' },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
}));

// Mock global fetch — coordinator fans out via fetch().
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST } from '@/app/api/cron/renewals/dispatch-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron dispatch-coordinator route (T103)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
  });

  it('401 on wrong Bearer (timing-safe)', async () => {
    const res = await POST(
      makeRequest({ authorization: 'Bearer wrong-secret-32-bytes-long-aaaa' }),
    );
    expect(res.status).toBe(401);
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch)', async () => {
    const env = (await import('@/lib/env')).env as { features: { f8Renewals: boolean } };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditEmitMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('happy path: fans out to per-tenant route + emits audit + returns aggregated summary', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        reminders_dispatched: 12,
        tasks_created: 2,
        duration_ms: 3200,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.tenants_enqueued).toBe(1);
    expect(body.tenants_succeeded).toBe(1);
    expect(body.tenants_failed).toBe(0);
    expect(body.per_tenant_results).toHaveLength(1);
    expect(body.per_tenant_results[0].tenant_id).toBe(TENANT_SLUG);
    expect(body.per_tenant_results[0].reminders_dispatched).toBe(12);
    // Fetch hit the per-tenant URL with Bearer + correlation id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect(fetchArgs[0]).toBe(
      `${BASE_URL}/api/cron/renewals/dispatch/${encodeURIComponent(TENANT_SLUG)}`,
    );
    expect(fetchArgs[1].method).toBe('POST');
    expect(fetchArgs[1].headers.Authorization).toBe(`Bearer ${CRON_SECRET}`);
    // cron_dispatch_orchestrated audit emitted.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_dispatch_orchestrated',
    );
  });

  it('per-tenant fetch failure: counted as failed in summary, audit still emitted', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(0);
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toContain('connection refused');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('per-tenant fetch returns non-2xx: counted as failed (http_500)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'dispatch_failed' } }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toBe('http_500');
  });

  it('audit emit failure swallowed (does not break response)', async () => {
    auditEmitMock.mockRejectedValueOnce(new Error('audit db down'));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        reminders_dispatched: 1,
        tasks_created: 0,
        duration_ms: 100,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(1);
  });
});
