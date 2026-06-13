/**
 * F8-completion slice 2 · Task 2.4 — enter-awaiting-payment cron route
 * pair contract test (per-tenant + coordinator).
 *
 * Mirrors `per-tenant.test.ts` + `lapse-coordinator.test.ts`. Pins the
 * three load-bearing behaviours the plan requires:
 *   - Bearer-less request → 401 + `cron_bearer_auth_rejected` audit.
 *   - READ_ONLY_MODE → 200 + skipped (coordinator short-circuit).
 *   - valid Bearer → invokes the use-case (per-tenant) / fans out +
 *     returns per-tenant counts (coordinator).
 *
 * Also covers the kill-switch (FEATURE_F8_RENEWALS=false → 200 skipped)
 * and the single-tenant guard (unknown slug → 400) on the per-tenant
 * route, matching the lapse route-pair contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    tenant: { slug: 'tenanta' },
    app: { baseUrl: 'http://localhost:3100' },
    log: { level: 'silent' },
    upstash: {
      url: 'https://test.upstash.io',
      token: 'test-token-with-enough-length-for-zod-min-20',
    },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const txExecuteMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: txExecuteMock }),
}));

const enterMock = vi.hoisted(() => vi.fn());
const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    enterAwaitingPaymentOnExpiry: enterMock,
    makeRenewalsDeps: vi.fn(() => ({
      tenant: { slug: 'tenanta' },
      auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
    })),
  };
});

const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

vi.mock('@/lib/otel-tracer', () => ({
  renewalsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: (k: string, v: unknown) => void }) => unknown,
  ) => fn({ setAttribute: () => {} }),
}));

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    cronBearerAuthRejected: vi.fn(),
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
    coordinatorSkippedReadOnly: vi.fn(),
    coordinatorTenantsEnqueued: vi.fn(),
    coordinatorTenantsSucceeded: vi.fn(),
    coordinatorTenantsFailed: vi.fn(),
    coordinatorDurationMs: vi.fn(),
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST as perTenantPOST } from '@/app/api/cron/renewals/enter-awaiting-payment/[tenantId]/route';
import { POST as coordinatorPOST } from '@/app/api/cron/renewals/enter-awaiting-payment-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };
const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });

describe('cron enter-awaiting-payment per-tenant route (slice 2 / T2.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enterMock.mockResolvedValue(
      ok({ cyclesProcessed: 4, flipped: 3, raceSkipped: 1, errors: 0 }),
    );
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await perTenantPOST(makeRequest({}), params(TENANT_SLUG));
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
    expect(enterMock).not.toHaveBeenCalled();
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await perTenantPOST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(enterMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('400 unknown_tenant on a slug that is not env.tenant.slug', async () => {
    const res = await perTenantPOST(makeRequest(VALID_AUTH), params('other-tenant'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_tenant');
    expect(enterMock).not.toHaveBeenCalled();
  });

  it('valid Bearer → invokes the use-case + returns the per-tenant counts', async () => {
    const res = await perTenantPOST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    expect(enterMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.cycles_processed).toBe(4);
    expect(body.flipped).toBe(3);
    expect(body.race_skipped).toBe(1);
    expect(body.errors).toBe(0);
    // Advisory lock acquired (disjoint enter-awaiting namespace).
    expect(txExecuteMock).toHaveBeenCalled();
  });
});

describe('cron enter-awaiting-payment-coordinator route (slice 2 / T2.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await coordinatorPOST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(
      '/api/cron/renewals/enter-awaiting-payment-coordinator',
    );
  });

  it('200 + skipped on READ_ONLY_MODE=true (no audit, no fan-out)', async () => {
    const env = (await import('@/lib/env')).env as {
      flags: { readOnlyMode: boolean };
    };
    env.flags.readOnlyMode = true;
    try {
      const res = await coordinatorPOST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('read_only_mode');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditEmitMock).not.toHaveBeenCalled();
    } finally {
      env.flags.readOnlyMode = false;
    }
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await coordinatorPOST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('valid Bearer → fans out to the per-tenant route + returns per-tenant counts + emits cron_dispatch_orchestrated (cron_kind=enter_awaiting)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        cycles_processed: 4,
        flipped: 3,
        race_skipped: 1,
        errors: 0,
        duration_ms: 700,
      }),
    });
    const res = await coordinatorPOST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.tenants_enqueued).toBe(1);
    expect(body.tenants_succeeded).toBe(1);
    expect(body.per_tenant_results[0].flipped).toBe(3);
    expect(body.per_tenant_results[0].race_skipped).toBe(1);
    // Orchestrated audit with the enter_awaiting cron_kind discriminator.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    expect((event.payload as { cron_kind: string }).cron_kind).toBe(
      'enter_awaiting',
    );
  });

  it('per-tenant fetch rejection → audit-row error="fetch_rejected" (PII redaction)', async () => {
    fetchMock.mockRejectedValue(
      new Error('connection terminated host=ep-xxx.aws.neon.tech password=hunter2'),
    );
    const res = await coordinatorPOST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toBe('fetch_rejected');
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain('hunter2');
    expect(bodyText).not.toContain('aws.neon.tech');
  });
});
