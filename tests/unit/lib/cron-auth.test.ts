/**
 * R5-WRN-2 (staff-review-2026-05-09 Round 2) — direct unit suite for
 * `gateCronBearerOrRespond` shared cron auth gate.
 *
 * Coordinator-level tests (e.g. `at-risk-coordinator.test.ts`,
 * `dispatch-coordinator.test.ts`) cover the helper indirectly via the
 * route handlers, but they all mock the same dependencies in the same
 * way. This direct suite asserts the helper's specific contract so a
 * future bug in fail-open / rate-limit / audit-emit semantics is caught
 * at the helper layer (one test file) instead of accidentally regressing
 * across all 4 coordinators (many test files).
 *
 * Covers all 4 contract paths:
 *   1. Success — Bearer matches → returns null
 *   2. Bad Bearer + audit emit succeeds → 401 + audit row
 *   3. Bad Bearer + Upstash check throws → fail-open → 401 + audit + warn-log
 *   4. Bad Bearer + audit emit throws → 401 + metricsCounter invoked
 *   5. Bad Bearer + rate-limit exceeded → 429 + Retry-After header
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// vi.mock factories run BEFORE module-scope const initialisation
// (vitest hoists them) — so reference literal values inline here.
// `CRON_SECRET` and `TENANT_SLUG` re-declared at outer scope below for
// the test bodies to reference identical values.
vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    tenant: { slug: 'tenanta' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const TENANT_SLUG = 'tenanta';
const ROUTE = '/api/cron/renewals/dispatch-coordinator';

const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: TENANT_SLUG },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
}));

const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));
vi.mock('@/lib/client-ip', () => ({
  getClientIp: vi.fn(() => '203.0.113.7'),
}));

import { gateCronBearerOrRespond } from '@/lib/cron-auth';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };
const BAD_AUTH = { authorization: 'Bearer wrong-secret-32-bytes-long-aaaa' };

describe('gateCronBearerOrRespond — R5-WRN-2 direct unit suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiterCheckMock.mockResolvedValue({ success: true, reset: 0 });
  });

  it('returns null on valid Bearer (caller proceeds)', async () => {
    const result = await gateCronBearerOrRespond(makeRequest(VALID_AUTH), {
      route: ROUTE,
    });
    expect(result).toBeNull();
    // No audit emit on the success path — the helper must not write a
    // row when the request is legitimate (would inflate audit-log
    // volume + obscure the security signal).
    expect(auditEmitMock).not.toHaveBeenCalled();
    // Rate-limit not consulted on the success path either.
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
  });

  it('returns 401 + emits cron_bearer_auth_rejected with route discriminator on bad Bearer', async () => {
    const result = await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: ROUTE,
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json();
    expect(body.error.code).toBe('unauthorized');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(ROUTE);
  });

  it('returns 401 + audit even when missing Authorization header entirely', async () => {
    const result = await gateCronBearerOrRespond(makeRequest({}), {
      route: ROUTE,
    });
    expect(result!.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('fails open on Upstash outage — proceeds to audit + 401 (does NOT 5xx)', async () => {
    // Simulate Upstash unreachable. The helper MUST treat this as
    // "rate-limit not enforced" rather than blocking the security
    // gate — the audit emit + 401 still fire.
    rateLimiterCheckMock.mockRejectedValueOnce(
      new Error('Upstash: connection timeout'),
    );
    const result = await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: ROUTE,
    });
    expect(result!.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 + Retry-After when bearer-rejected rate limit exceeded; NO audit emit', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const result = await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: ROUTE,
    });
    expect(result!.status).toBe(429);
    const body = await result!.json();
    expect(body.error.code).toBe('rate_limited');
    expect(result!.headers.get('Retry-After')).toBe('42');
    // K12-6 design: on 429 the audit row is INTENTIONALLY suppressed
    // to cap DB-write amplification under brute-force probing. The
    // forensic signal is preserved at the rate-limited cadence (one
    // row per IP per minute) by the legitimate 401 path.
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('invokes metricsCounter when audit emit fails AND still returns 401 (security gate must not be skipped)', async () => {
    // Audit-emit failure must NOT swallow the 401 — the security
    // contract is: "deny the request, surface the failure via
    // metricsCounter + log so SRE can alert on sustained loss".
    auditEmitMock.mockRejectedValueOnce(new Error('audit_log: insert failed'));
    const metricsCounterMock = vi.fn();
    const result = await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: ROUTE,
      metricsCounter: metricsCounterMock,
    });
    expect(result!.status).toBe(401);
    expect(metricsCounterMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke metricsCounter on the success path (counter is for emit failures only)', async () => {
    const metricsCounterMock = vi.fn();
    await gateCronBearerOrRespond(makeRequest(VALID_AUTH), {
      route: ROUTE,
      metricsCounter: metricsCounterMock,
    });
    expect(metricsCounterMock).not.toHaveBeenCalled();
  });

  it('different routes produce distinct audit payload.route values (forensic-source discrimination)', async () => {
    await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: '/api/cron/renewals/at-risk-recompute-coordinator',
    });
    await gateCronBearerOrRespond(makeRequest(BAD_AUTH), {
      route: '/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator',
    });
    expect(auditEmitMock).toHaveBeenCalledTimes(2);
    expect(
      (auditEmitMock.mock.calls[0]![0].payload as { route: string }).route,
    ).toBe('/api/cron/renewals/at-risk-recompute-coordinator');
    expect(
      (auditEmitMock.mock.calls[1]![0].payload as { route: string }).route,
    ).toBe('/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator');
  });
});
