/**
 * 107-auto-invoice Task 8 — auto-draft cron route pair contract test
 * (per-tenant worker + coordinator).
 *
 * Mirrors `enter-awaiting-payment-route.test.ts` (F8-completion slice 2 /
 * T2.4) — same 5-scenario contract, adapted for the auto-draft cron:
 *   - Bearer-less request → 401 + `cron_bearer_auth_rejected` audit.
 *   - `FEATURE_AUTO_INVOICE=false` (either of the two dark-ship env keys
 *     off — `f8Renewals` or `autoInvoice`) → 200 + skipped, use-case never
 *     invoked / no fan-out.
 *   - READ_ONLY_MODE → 200 + skipped (coordinator short-circuit only —
 *     mirrors every other F8 coordinator; the worker has no read-only
 *     check of its own, matching the enter-awaiting-payment precedent).
 *   - valid Bearer → invokes `autoDraftDueRenewals` (worker) / fans out +
 *     returns per-tenant counts + emits `cron_dispatch_orchestrated`
 *     (`cron_kind: 'auto_draft'`) (coordinator).
 *   - single-tenant guard: unknown slug → 400 `unknown_tenant` (worker).
 *
 * Deliberately does NOT mock `@/lib/db` — per the auto-invoice Task 8
 * ambiguity resolution, the worker route does NOT open its own
 * `runInTenant` + advisory lock (unlike `enter-awaiting-payment`'s
 * worker). `autoDraftDueRenewals` (Task 7) manages its own split-tx
 * internally via `deps.tenant`, and is itself mocked here — Task 7's own
 * integration suite (`tests/integration/renewals/auto-draft-due-
 * renewals.test.ts`) already covers the real-Neon drafting behaviour.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true, autoInvoice: true },
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

// `vi.importActual` below loads the REAL `@/modules/renewals` barrel to
// spread its other exports — that transitively evaluates
// `renewals-deps.ts`, whose Drizzle adapters import `@/lib/db` at
// module scope (a real Postgres client keyed off `env.db.url`, which
// our minimal mocked `env` above doesn't have).
//
// The WORKER route still never calls `runInTenant`/`db` directly (Task 8
// ambiguity resolution #1 — it never opens its own outer tx). The
// COORDINATOR does, as of Task 16: `observeAutoInvoiceGaugesForTenant`
// runs one aggregate under `runInTenant` to feed the auto-invoice gauges.
// (Review M-3 — this comment previously claimed neither route did, which
// stopped being true and is the first thing a reader of this file sees.)
//
// `runInTenantMock` is overridable per-test so the gauge feed's
// never-block guarantee can actually be exercised — see the
// "gauge feed is non-blocking" describe block. The default resolves
// `execute` to `undefined`, which the route's `?? []` turns into an empty
// rowset and an early return, so the gauge path no-ops for every test
// that is not specifically about it.
const runInTenantMock = vi.hoisted(() =>
  vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: vi.fn(async () => undefined) }),
  ),
);

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: runInTenantMock,
}));

const autoDraftMock = vi.hoisted(() => vi.fn());
const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    autoDraftDueRenewals: autoDraftMock,
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

import { POST as perTenantPOST } from '@/app/api/cron/renewals/auto-draft/[tenantId]/route';
import { POST as coordinatorPOST } from '@/app/api/cron/renewals/auto-draft-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };
const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });

describe('cron auto-draft per-tenant worker route (auto-invoice #2 / Task 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoDraftMock.mockResolvedValue(
      ok({
        drafted: 3,
        skippedExisting: 1,
        skippedRaceLost: 1,
        skippedTerminated: 0,
        errors: 0,
        cyclesProcessed: 5,
      }),
    );
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await perTenantPOST(makeRequest({}), params(TENANT_SLUG));
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
    expect(autoDraftMock).not.toHaveBeenCalled();
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
      expect(autoDraftMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('200 + skipped on FEATURE_AUTO_INVOICE=false (dark-ship key #1)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { autoInvoice: boolean };
    };
    env.features.autoInvoice = false;
    try {
      const res = await perTenantPOST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(autoDraftMock).not.toHaveBeenCalled();
    } finally {
      env.features.autoInvoice = true;
    }
  });

  it('400 unknown_tenant on a slug that is not env.tenant.slug', async () => {
    const res = await perTenantPOST(makeRequest(VALID_AUTH), params('other-tenant'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_tenant');
    expect(autoDraftMock).not.toHaveBeenCalled();
  });

  it('valid Bearer → invokes autoDraftDueRenewals + returns the per-tenant counters', async () => {
    const res = await perTenantPOST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    expect(autoDraftMock).toHaveBeenCalledTimes(1);
    const [, callInput] = autoDraftMock.mock.calls[0]!;
    expect(callInput.tenantId).toBe(TENANT_SLUG);
    expect(typeof callInput.correlationId).toBe('string');
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.drafted).toBe(3);
    expect(body.skipped_existing).toBe(1);
    expect(body.skipped_race_lost).toBe(1);
    expect(body.skipped_terminated).toBe(0);
    expect(body.errors).toBe(0);
    expect(body.cycles_processed).toBe(5);
    // Never wraps the use-case in an outer runInTenant/advisory lock —
    // autoDraftDueRenewals manages its own split-tx internally (Task 7).
    expect(typeof body.duration_ms).toBe('number');
  });
});

describe('cron auto-draft-coordinator route (auto-invoice #2 / Task 8)', () => {
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
      '/api/cron/renewals/auto-draft-coordinator',
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

  it('200 + skipped on FEATURE_AUTO_INVOICE=false (dark-ship key #1)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { autoInvoice: boolean };
    };
    env.features.autoInvoice = false;
    try {
      const res = await coordinatorPOST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.features.autoInvoice = true;
    }
  });

  it('valid Bearer → fans out to the per-tenant worker + returns counts + emits cron_dispatch_orchestrated (cron_kind=auto_draft)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        drafted: 3,
        skipped_existing: 1,
        skipped_race_lost: 1,
        skipped_terminated: 0,
        errors: 0,
        cycles_processed: 5,
        duration_ms: 700,
      }),
    });
    const res = await coordinatorPOST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0]!;
    expect(fetchUrl).toBe(
      `http://localhost:3100/api/cron/renewals/auto-draft/${TENANT_SLUG}`,
    );
    expect(fetchInit.headers.Authorization).toBe(`Bearer ${CRON_SECRET}`);

    const body = await res.json();
    expect(body.tenants_enqueued).toBe(1);
    expect(body.tenants_succeeded).toBe(1);
    expect(body.per_tenant_results[0].drafted).toBe(3);
    expect(body.per_tenant_results[0].skipped_existing).toBe(1);

    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    const payload = event.payload as {
      cron_kind: string;
      per_tenant_summaries: ReadonlyArray<{
        kind_specific?: { kind: string; errors: number; drafted?: number; skipped?: number };
      }>;
    };
    expect(payload.cron_kind).toBe('auto_draft');
    expect(payload.per_tenant_summaries[0]?.kind_specific).toEqual({
      kind: 'auto_draft',
      errors: 0,
      drafted: 3,
      skipped: 2, // skipped_existing(1) + skipped_race_lost(1) + skipped_terminated(0)
    });
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

  // -------------------------------------------------------------------------
  // Task 16 review MAJOR-3 — the gauge feed's never-block guarantee.
  //
  // The default `runInTenantMock` resolves `execute` to `undefined`, which
  // the route turns into `[]` and returns early from — so every test above
  // exercises a gauge path that does nothing. The whole "a metrics failure
  // must never fail or delay the cron" claim therefore had ZERO coverage.
  // These cases make the feed actually fail and assert the cron is unharmed.
  // -------------------------------------------------------------------------
  describe('gauge feed is non-blocking (review MAJOR-3)', () => {
    const OK_WORKER_RESPONSE = {
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        drafted: 3,
        skipped_existing: 1,
        skipped_race_lost: 0,
        skipped_terminated: 0,
        errors: 0,
        cycles_processed: 4,
        duration_ms: 700,
      }),
    };

    it('a REJECTING gauge query still returns 200 with an unchanged summary', async () => {
      fetchMock.mockResolvedValue(OK_WORKER_RESPONSE);
      runInTenantMock.mockRejectedValueOnce(
        new Error('relation "invoices" does not exist'),
      );

      const res = await coordinatorPOST(makeRequest(VALID_AUTH));

      expect(res.status).toBe(200);
      const body = await res.json();
      // The summary is computed from the fan-out, not the gauge feed —
      // a broken gauge must not make a healthy pass look failed.
      expect(body.tenants_enqueued).toBe(1);
      expect(body.tenants_succeeded).toBe(1);
      expect(body.tenants_failed).toBe(0);
      expect(body.per_tenant_results[0].drafted).toBe(3);
      // The durable audit row is still written.
      expect(auditEmitMock).toHaveBeenCalledTimes(1);
      expect(auditEmitMock.mock.calls[0]![0].type).toBe(
        'cron_dispatch_orchestrated',
      );
    });

    it('a THROWING gauge query does not prevent the audit row', async () => {
      fetchMock.mockResolvedValue(OK_WORKER_RESPONSE);
      runInTenantMock.mockImplementationOnce(() => {
        throw new Error('synchronous explosion inside runInTenant');
      });

      const res = await coordinatorPOST(makeRequest(VALID_AUTH));

      expect(res.status).toBe(200);
      expect(auditEmitMock).toHaveBeenCalledTimes(1);
    });

    it('the gauge feed runs AFTER the audit emit + duration metric (ordering)', async () => {
      // Review MAJOR-1: gauge latency must not be folded into
      // `renewals.coordinator.duration_ms` or delay the durable audit row.
      // Pin the ordering by recording when each side ran.
      const order: string[] = [];
      auditEmitMock.mockImplementationOnce(async () => {
        order.push('audit');
      });
      runInTenantMock.mockImplementationOnce(async () => {
        order.push('gauge');
        return [];
      });
      fetchMock.mockResolvedValue(OK_WORKER_RESPONSE);

      await coordinatorPOST(makeRequest(VALID_AUTH));

      expect(order).toEqual(['audit', 'gauge']);
    });
  });
});
