/**
 * #754 follow-up — per-tenant reconcile-pending-reactivations route: an overlapping
 * run takes a NON-blocking try-lock and skips at once (200 `overlap`)
 * instead of waiting out runInTenant's 30 s statement bound and failing
 * 57014 → 500.
 *
 * Mirrors `lapse-per-tenant-escalation.test.ts` mock scaffolding.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

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

const txExecuteMock = vi.hoisted(() =>
  vi.fn(async (_q?: unknown): Promise<unknown> => [{ acquired: true }]),
);
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: txExecuteMock }),
}));

const reconcileMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    reconcilePendingReactivations: reconcileMock,
    makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: 'tenanta' } })),
  };
});

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: vi.fn(async () => ({ success: true, reset: 0 })) },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
  },
}));

import { POST } from '@/app/api/cron/renewals/reconcile-pending-reactivations/[tenantId]/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}
const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };
const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });

describe('cron reconcile-pending-reactivations per-tenant route — overlap (#754 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an overlapping run skips at once with 200 overlap, no reconcile pass', async () => {
    txExecuteMock.mockResolvedValueOnce([{ acquired: false }]);
    const res = await POST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: true,
      reason: 'overlap',
      tenant_id: TENANT_SLUG,
    });
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
