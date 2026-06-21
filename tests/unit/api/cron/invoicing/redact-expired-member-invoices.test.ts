/**
 * COMP-1 US3-B — unit coverage for the redact-expired-member-invoices cron's
 * SCAN-LEVEL control branches that the live-Neon integration suite cannot easily
 * induce without poisoning real data:
 *
 *   (1) BAD / MISSING Bearer → 401 `unauthorized` (constant-time gate, before
 *       any DB access).
 *   (2) tenant-list query FAILURE → 500 `tenant_list_failed` (the whole scan
 *       aborts; no tenant is swept).
 *   (3) PER-TENANT failure ISOLATION → one poisoned tenant (its `runInTenant`
 *       throws) increments `tenantsErrored` in a 200 body WITHOUT aborting the
 *       sweep; the OTHER tenants are still swept (the throw-path-in-a-best-
 *       effort-loop class — a single bad tenant must not block the rest).
 *
 * `@/lib/db` is fully mocked here so the cross-tenant tenant-list query and a
 * targeted `runInTenant` throw are deterministic. The HAPPY-path redaction
 * (tombstone + audit + blob purge + idempotency + the matched-member-event gap
 * case) is pinned by the integration suite against live Neon Singapore — this
 * file owns ONLY the scan-level auth + failure-isolation contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// NB: inline the secret string inside the `vi.mock` factory below — the
// factory is hoisted above all top-level `const`s, so it cannot reference
// `CRON_SECRET`. The exported `CRON_SECRET` mirror is used by the tests' own
// VALID_AUTH header (which is NOT hoisted).
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    log: { level: 'silent' },
    // The route imports `db`/`runInTenant` from `@/lib/db` (mocked below); the
    // real module reads `env.database.url` at init. Stub so the partial-env
    // mock does not crash a transitive import.
    database: { url: 'postgresql://stub:stub@localhost/stub' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

// Configurable test seams. `tenantListImpl` drives the cross-tenant tenant-list
// `db.execute`; `runInTenantImpl` drives per-tenant work (default: a no-op that
// returns the zero-redaction result the route's per-tenant body expects).
const tenantListImpl = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ tenant_id: string }>> => []),
);
const runInTenantImpl = vi.hoisted(() =>
  vi.fn(async (slug: string): Promise<{ tenantRedacted: number; purgeWork: unknown[] }> => {
    void slug;
    return { tenantRedacted: 0, purgeWork: [] };
  }),
);

vi.mock('@/lib/db', () => ({
  db: { execute: vi.fn(() => tenantListImpl()) },
  runInTenant: async <T>(ctx: { slug: string }, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    // The mocked per-tenant body decides the outcome (or throws). The route's
    // own `fn` is NOT invoked — we model the tenant pass at the seam so a throw
    // can be injected per tenant. The tx stub satisfies any incidental call.
    void fn;
    return runInTenantImpl(ctx.slug) as Promise<T>;
  },
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));

const memberDocumentPiiRedactedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  invoicingMetrics: { memberDocumentPiiRedacted: memberDocumentPiiRedactedMock },
  // cron-auth (imported transitively by the route) references renewalsMetrics
  // at module scope — provide a no-op so module-init does not crash.
  renewalsMetrics: { cronBearerAuthRejected: vi.fn(), redisFallback: vi.fn() },
}));

const auditEmitMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/modules/invoicing/infrastructure/adapters/audit-adapter', () => ({
  f4AuditAdapter: { emit: auditEmitMock },
}));

const blobDeleteMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: { delete: blobDeleteMock },
}));

import { POST } from '@/app/api/cron/invoicing/redact-expired-member-invoices/route';

function makeRequest(authorization: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = `Bearer ${CRON_SECRET}`;

describe('redact-expired-member-invoices cron — scan-level branches (COMP-1 US3-B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantListImpl.mockResolvedValue([]);
    runInTenantImpl.mockResolvedValue({ tenantRedacted: 0, purgeWork: [] });
  });

  it('(1) 401 + unauthorized on a MISSING Authorization header (gate before DB access)', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    // The tenant-list query must NOT run when auth fails.
    expect(tenantListImpl).not.toHaveBeenCalled();
  });

  it('(1b) 401 + unauthorized on a WRONG Bearer token', async () => {
    const res = await POST(makeRequest('Bearer wrong-secret-deadbeef-0000000000000000'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(tenantListImpl).not.toHaveBeenCalled();
  });

  it('(2) 500 + tenant_list_failed when the tenant-list query throws (scan aborts)', async () => {
    tenantListImpl.mockRejectedValueOnce(new Error('connection reset by peer'));
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('tenant_list_failed');
    // No tenant pass ran — the scan aborted at the tenant-list step.
    expect(runInTenantImpl).not.toHaveBeenCalled();
  });

  it('(3) per-tenant failure ISOLATION: a poisoned tenant bumps tenantsErrored in a 200 body; the others are still swept', async () => {
    // Three tenants; the middle one's per-tenant pass throws.
    tenantListImpl.mockResolvedValue([
      { tenant_id: 'tenant-a' },
      { tenant_id: 'tenant-poison' },
      { tenant_id: 'tenant-c' },
    ]);
    runInTenantImpl.mockImplementation(async (slug: string) => {
      if (slug === 'tenant-poison') {
        throw new Error('simulated per-tenant failure (RLS GUC set failed)');
      }
      return { tenantRedacted: slug === 'tenant-a' ? 1 : 0, purgeWork: [] };
    });

    const res = await POST(makeRequest(VALID_AUTH));
    // A single bad tenant must NOT abort the scan — it stays 200.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      redactedCount: number;
      tenantsSwept: number;
      tenantsErrored: number;
    };
    expect(body.ok).toBe(true);
    // The poisoned tenant is counted as errored…
    expect(body.tenantsErrored).toBe(1);
    // …and the OTHER two tenants were swept (not aborted).
    expect(body.tenantsSwept).toBe(2);
    // tenant-a redacted one row; the scan continued past the poison tenant.
    expect(body.redactedCount).toBe(1);

    // All three tenants were attempted (proves the loop did not break early).
    expect(runInTenantImpl).toHaveBeenCalledTimes(3);
    const sweptSlugs = runInTenantImpl.mock.calls.map((c) => c[0]);
    expect(sweptSlugs).toEqual(['tenant-a', 'tenant-poison', 'tenant-c']);

    // The poisoned tenant emitted the error metric (alerting anchor).
    const errorOutcomes = memberDocumentPiiRedactedMock.mock.calls.filter((c) => c[0] === 'error');
    expect(errorOutcomes.length).toBeGreaterThanOrEqual(1);
    expect(errorOutcomes.some((c) => c[1] === 'tenant-poison')).toBe(true);

    // …and the SUCCESS metric arms fired with the right per-tenant tag (the
    // route emits `memberDocumentPiiRedacted(redacted > 0 ? 'redacted' :
    // 'swept_zero', tenantSlug)` at the END of each NON-throwing tenant pass):
    //   • tenant-a redacted ≥1 row → the 'redacted' arm, tagged 'tenant-a'.
    //   • tenant-c had nothing due → the 'swept_zero' arm, tagged 'tenant-c'.
    const redactedOutcomes = memberDocumentPiiRedactedMock.mock.calls.filter(
      (c) => c[0] === 'redacted',
    );
    expect(redactedOutcomes).toEqual([['redacted', 'tenant-a']]);
    const sweptZeroOutcomes = memberDocumentPiiRedactedMock.mock.calls.filter(
      (c) => c[0] === 'swept_zero',
    );
    expect(sweptZeroOutcomes).toEqual([['swept_zero', 'tenant-c']]);
    // The poisoned tenant threw BEFORE reaching the success-metric line, so it
    // appears in NEITHER success arm — only the 'error' arm asserted above.
    expect(redactedOutcomes.some((c) => c[1] === 'tenant-poison')).toBe(false);
    expect(sweptZeroOutcomes.some((c) => c[1] === 'tenant-poison')).toBe(false);
  });

  it('(3b) happy multi-tenant scan: zero errors, all swept', async () => {
    tenantListImpl.mockResolvedValue([{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }]);
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantsSwept: number; tenantsErrored: number };
    expect(body.tenantsErrored).toBe(0);
    expect(body.tenantsSwept).toBe(2);
  });
});
