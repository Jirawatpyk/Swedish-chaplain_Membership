/**
 * F8 Phase 6 review I9 — Bearer + kill-switch + audit coverage for the
 * per-tenant at-risk recompute route. Mirrors
 * `tests/unit/api/cron/renewals/per-tenant.test.ts` (the dispatch
 * flavour) — both files now live side-by-side. Pins:
 *   - C2 fix (`cron_bearer_auth_rejected` audit on 401 path)
 *   - C1 fix (advisory-lock + batched recompute atomic via tx)
 *   - I10 fix (per-skipped-member audit emitted via use-case)
 * so a future refactor that drops any of these fails CI.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true, f8AtRiskDisabled: false },
    tenant: { slug: 'tenanta' },
    log: { level: 'silent' },
    // QA Round 1 fix — `vi.importActual('@/modules/renewals')` triggers
    // transitive load of renewals-deps → upstash-rate-limiter +
    // resend-client which read these at module-init.
    upstash: {
      url: 'https://test.upstash.io',
      token: 'test-token-with-enough-length-for-zod-min-20',
    },
    resend: {
      apiKey: 're_test_placeholder',
      webhookSigningSecret: 'whsec_test_placeholder',
      fromEmail: 'noreply@test.example',
    },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const txExecuteMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix collection error.
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: txExecuteMock }),
}));

const recomputeMock = vi.hoisted(() => vi.fn());
const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
const auditEmitInTxMock = vi.hoisted(() =>
  vi.fn(async (_tx: unknown, _e: unknown, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    recomputeAtRiskScoresBatch: recomputeMock,
    makeRenewalsDeps: vi.fn(() => ({
      tenant: { slug: 'tenanta' },
      auditEmitter: { emit: auditEmitMock, emitInTx: auditEmitInTxMock },
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

import { POST } from '@/app/api/cron/renewals/at-risk-recompute/[tenantId]/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    url: 'http://localhost:3100/api/cron/renewals/at-risk-recompute/tenanta',
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

async function callPost(headers: Record<string, string>) {
  return POST(makeRequest(headers), {
    params: Promise.resolve({ tenantId: TENANT_SLUG }),
  });
}

describe('cron at-risk per-tenant route (Phase 6 review I9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await callPost({});
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toContain(
      '/api/cron/renewals/at-risk-recompute/',
    );
  });

  it('429 on rate-limit hit (no audit)', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const res = await callPost({});
    expect(res.status).toBe(429);
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await callPost(VALID_AUTH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(recomputeMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('200 + skipped on FEATURE_F8_AT_RISK_DISABLED=true (FR-052b)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8AtRiskDisabled: boolean };
    };
    env.features.f8AtRiskDisabled = true;
    try {
      const res = await callPost(VALID_AUTH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('at_risk_disabled');
      expect(recomputeMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8AtRiskDisabled = false;
    }
  });

  it('acquires renewals:at-risk: advisory_xact_lock before calling use-case (Phase 6 C1 atomicity)', async () => {
    recomputeMock.mockResolvedValue(
      ok({
        membersTotal: 5,
        membersRecomputed: 5,
        membersSkippedBelowTenure: 0,
        membersFailed: 0,
        durationMs: 100,
      }),
    );
    const res = await callPost(VALID_AUTH);
    expect(res.status).toBe(200);
    // The advisory lock SQL is the FIRST tx.execute call, before the
    // use-case runs.
    expect(txExecuteMock).toHaveBeenCalled();
    const lockCall = txExecuteMock.mock.calls[0] as unknown[] | undefined;
    expect(lockCall).toBeDefined();
    // Staff-Review-2026-05-09 SUG-2 fix: assert against `queryChunks`
    // (the documented Drizzle SQL tagged-template AST) instead of a
    // black-box `JSON.stringify(lockCall[0])` over the entire `SQL`
    // object. queryChunks is the public template-AST surface that
    // contains the raw template literal segments — stable across
    // Drizzle's internal refactors of decoder/usedTables/etc. fields
    // (the latter would silently flip to "[object Object]" if the
    // serialiser changed). Stringify only the chunks so future
    // Drizzle minor versions can rearrange other internals without
    // breaking this assertion.
    const sqlObject = lockCall![0] as { queryChunks?: unknown };
    expect(sqlObject.queryChunks).toBeDefined();
    const chunksText = JSON.stringify(sqlObject.queryChunks);
    expect(chunksText).toContain('renewals:at-risk:');
    expect(chunksText).toContain('pg_advisory_xact_lock');
    // R2-S4: pin tenantSlug substring so a future refactor that drops
    // the tenant scope from the lock-namespace key can't silently pass.
    // The TENANT constant is the slug used by the test fixture.
    expect(chunksText).toContain(TENANT_SLUG);
    // Use-case received a tx (C1 fix — atomic with the lock).
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    const recomputeArgs = recomputeMock.mock.calls[0] as unknown[] | undefined;
    expect(recomputeArgs).toBeDefined();
    expect(recomputeArgs![2]).toBeDefined(); // externalTx parameter
  });

  it('emits at_risk_compute_partial_failure audit when use-case reports failures', async () => {
    recomputeMock.mockResolvedValue(
      ok({
        membersTotal: 100,
        membersRecomputed: 95,
        membersSkippedBelowTenure: 0,
        membersFailed: 5,
        durationMs: 1200,
      }),
    );
    const res = await callPost(VALID_AUTH);
    expect(res.status).toBe(200);
    // Partial-failure audit emitted in-tx (atomic with the recompute).
    expect(auditEmitInTxMock).toHaveBeenCalledTimes(1);
    const event = auditEmitInTxMock.mock.calls[0]![1] as {
      type: string;
      payload: { members_failed: number };
    };
    expect(event.type).toBe('at_risk_compute_partial_failure');
    expect(event.payload.members_failed).toBe(5);
  });

  it('500 when use-case returns server_error', async () => {
    recomputeMock.mockResolvedValue(
      err({ kind: 'server_error' as const, message: 'CTE timed out' }),
    );
    const res = await callPost(VALID_AUTH);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});
