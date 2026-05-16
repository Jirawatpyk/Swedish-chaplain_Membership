/**
 * T035 (F6.1 · Feature 013 — Phase 5 US5) — Contract test:
 * GET /api/admin/events/import/{recordId}/error-csv
 *
 * Source: specs/013-csv-import-eventcreate-format/contracts/error-csv-signed-url-api.md
 *
 * Coverage (HTTP-level, mocked use-case):
 *   - 307 happy path — Location header points to signed URL
 *   - 404 not_found (own tenant or cross-tenant — same surface)
 *   - 404 expired blob (TTL passed)
 *   - 500 signing_failure with requestId in ProblemDetails body
 *   - 404 malformed recordId (not UUID v4)
 *   - 401 / 403 / 404 RBAC matrix (delegated to adminOnlyGuard mock)
 *   - 503 kill-switch
 *
 * The strict-audit invariant (audit emit MUST succeed before signed URL
 * is returned) is exercised by the use-case unit + integration tests
 * (T036/T037); this contract test focuses on the HTTP boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runGenerateErrorCsvSignedUrlMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const adminOnlyGuardMock = vi.fn();

vi.mock('@/lib/events-csv-import-deps', () => ({
  runGenerateErrorCsvSignedUrl: (...args: unknown[]) =>
    runGenerateErrorCsvSignedUrlMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

vi.mock(
  '@/app/api/admin/integrations/eventcreate/_lib/role-violation-audit',
  () => ({
    adminOnlyGuard: (...args: unknown[]) => adminOnlyGuardMock(...args),
  }),
);

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>(
    '@/lib/env',
  );
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f6EventCreate: true },
      tenant: { slug: 'test-swecham' },
    },
  };
});

const TENANT_SLUG = 'test-swecham';
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
const VALID_RECORD_ID = '11111111-2222-4333-8444-555555555555';
const SIGNED_URL =
  'https://blob.vercel-storage.com/tenants/test-swecham/csv-import-errors/abc.csv?token=signed&expires=1';

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  adminOnlyGuardMock.mockResolvedValue({
    kind: 'allow',
    actorUserId: ADMIN_USER_ID,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return (await import(
    '@/app/api/admin/events/import/[recordId]/error-csv/route'
  )) as {
    GET: (
      req: NextRequest,
      ctx: { params: Promise<{ recordId: string }> },
    ) => Promise<Response>;
  };
}

function buildRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `http://test/api/admin/events/import/${VALID_RECORD_ID}/error-csv`,
    { method: 'GET', headers },
  );
}

function ctxFor(recordId: string): {
  params: Promise<{ recordId: string }>;
} {
  return { params: Promise.resolve({ recordId }) };
}

describe('GET /api/admin/events/import/{recordId}/error-csv — F6.1 contract', () => {
  it('307 happy path — Location header points to signed URL + Cache-Control: no-store', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'success',
      signedUrl: SIGNED_URL,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(307);
    expect(res.headers.get('Location')).toBe(SIGNED_URL);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('use-case receives sourceIp from X-Forwarded-For first hop', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'success',
      signedUrl: SIGNED_URL,
      expiresAt: new Date(),
    });
    const { GET } = await loadRoute();
    await GET(
      buildRequest({ 'X-Forwarded-For': '203.0.113.1, 10.0.0.1' }),
      ctxFor(VALID_RECORD_ID),
    );
    expect(runGenerateErrorCsvSignedUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIp: '203.0.113.1' }),
    );
  });

  it('404 not_found — record-truly-missing surfaces ProblemDetails (no signed URL)', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'not_found',
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      title: string;
      detail: string;
      type: string;
    };
    expect(body.title).toMatch(/error csv not available/i);
    expect(body.type).toContain('error-csv-not-available');
  });

  it('404 expired — same ProblemDetails body as not_found (surface-disclosure invariant)', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'expired',
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { title: string };
    expect(body.title).toMatch(/error csv not available/i);
  });

  it('500 signing_failure — ProblemDetails with requestId; no Location header', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'signing_failure',
      message: 'Vercel Blob unavailable',
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
    const body = (await res.json()) as { requestId: string };
    expect(typeof body.requestId).toBe('string');
  });

  it('404 — malformed recordId (not UUID v4) short-circuits before use-case', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(runGenerateErrorCsvSignedUrlMock).not.toHaveBeenCalled();
  });

  it('403/404 — RBAC deny short-circuits before use-case', async () => {
    adminOnlyGuardMock.mockResolvedValueOnce({
      kind: 'deny',
      response: new Response(null, { status: 404 }),
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(404);
    expect(runGenerateErrorCsvSignedUrlMock).not.toHaveBeenCalled();
  });

  it('tenant resolution failure → 404 (defensive)', async () => {
    resolveTenantFromRequestMock.mockImplementationOnce(() => {
      throw new Error('no x-tenant header');
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(res.status).toBe(404);
  });

  it('recordId path param threaded through to use-case', async () => {
    runGenerateErrorCsvSignedUrlMock.mockResolvedValueOnce({
      kind: 'not_found',
    });
    const { GET } = await loadRoute();
    await GET(buildRequest(), ctxFor(VALID_RECORD_ID));
    expect(runGenerateErrorCsvSignedUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: VALID_RECORD_ID }),
    );
  });

  // 503 kill-switch verified at the runtime level — same rationale as
  // history-api.test.ts (env read at module-eval; mock pollution between
  // tests). Integration smoke covers the kill-switch path end-to-end.
});
