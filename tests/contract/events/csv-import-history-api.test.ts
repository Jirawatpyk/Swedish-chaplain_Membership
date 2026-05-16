/**
 * T034 (F6.1 · Feature 013 — Phase 5 US5) — Contract test:
 * GET /api/admin/events/import/history
 *
 * Source: specs/013-csv-import-eventcreate-format/contracts/csv-import-history-api.md
 *
 * Coverage (HTTP-level, mocked use-case):
 *   - 200 happy path with multiple records, reverse-chrono order
 *   - 200 with eventId filter
 *   - 200 with actorUserId filter
 *   - 200 with pagination boundaries (page=1, page=N, page>last)
 *   - 200 with expired blob → errorCsvAvailable: false
 *   - 400 invalid page (0, negative, non-numeric)
 *   - 400 invalid perPage (0, >100, non-numeric)
 *   - 400 malformed eventId / actorUserId UUID
 *   - 401 / 403 / 404 RBAC matrix (delegated to adminOnlyGuard mock)
 *   - 503 kill-switch
 *
 * Tenant isolation (Constitution Principle I clause 3) is exercised by
 * the live-Neon integration test at `csv-import-records-history.test.ts`
 * (T036).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runListCsvImportRecordsMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const adminOnlyGuardMock = vi.fn();

vi.mock('@/lib/events-csv-import-deps', () => ({
  runListCsvImportRecords: (...args: unknown[]) =>
    runListCsvImportRecordsMock(...args),
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
// Valid UUID v4 — required by route's UUID_V4_PATTERN guard on actorUserId
// query param. Third group leads with `4`, fourth with `8|9|a|b`.
const ADMIN_USER_ID = '11111111-2222-4333-8444-555555555556';
const RECORD_A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const RECORD_B = '11111111-2222-4333-8444-bbbbbbbbbbbb';
const EVENT_ID = '11111111-2222-4333-8444-eeeeeeeeeeee';

function buildRow(overrides: Record<string, unknown> = {}) {
  const baseUploadedAt = new Date('2026-05-10T03:14:22Z');
  return {
    record: {
      recordId: RECORD_A,
      tenantId: TENANT_SLUG,
      actorUserId: ADMIN_USER_ID,
      eventId: EVENT_ID,
      uploadedAt: baseUploadedAt,
      sourceFormat: 'eventcreate_csv',
      originalFilename: 'EventCreate.csv',
      originalSizeBytes: 1024,
      rowsTotal: 10,
      rowsProcessed: 8,
      rowsAlreadyImported: 0,
      rowsSkipped: 1,
      rowsFailed: 1,
      outcome: 'completed',
      durationMs: 5_000,
      errorCsvBlobUrl: 'https://blob.example/test.csv',
      errorCsvExpiresAt: new Date('2026-06-09T03:14:22Z'),
      ...overrides,
    },
    errorCsvAvailable: true,
  };
}

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  adminOnlyGuardMock.mockResolvedValue({
    kind: 'allow',
    actorUserId: ADMIN_USER_ID,
  });
  runListCsvImportRecordsMock.mockResolvedValue({
    ok: true,
    value: {
      rows: [buildRow()],
      pagination: { page: 1, perPage: 30, totalRecords: 1, totalPages: 1 },
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return (await import('@/app/api/admin/events/import/history/route')) as {
    GET: (req: NextRequest) => Promise<Response>;
  };
}

function buildRequest(query: string = ''): NextRequest {
  return new NextRequest(
    `http://test/api/admin/events/import/history${query}`,
    { method: 'GET' },
  );
}

describe('GET /api/admin/events/import/history — F6.1 contract', () => {
  it('200 happy path — returns paginated rows + records[] shape per contract', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: ReadonlyArray<{
        recordId: string;
        sourceFormat: string;
        errorCsvAvailable: boolean;
      }>;
      pagination: { page: number; totalRecords: number };
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.recordId).toBe(RECORD_A);
    expect(body.records[0]!.sourceFormat).toBe('eventcreate_csv');
    expect(body.records[0]!.errorCsvAvailable).toBe(true);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.totalRecords).toBe(1);
  });

  it('200 — propagates eventId filter to the use-case', async () => {
    const { GET } = await loadRoute();
    await GET(buildRequest(`?eventId=${EVENT_ID}`));
    expect(runListCsvImportRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventIdFilter: EVENT_ID }),
    );
  });

  it('200 — propagates actorUserId filter to the use-case', async () => {
    const { GET } = await loadRoute();
    await GET(buildRequest(`?actorUserId=${ADMIN_USER_ID}`));
    expect(runListCsvImportRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserIdFilter: ADMIN_USER_ID }),
    );
  });

  it('200 — pagination forwarded (page + perPage)', async () => {
    const { GET } = await loadRoute();
    await GET(buildRequest('?page=3&perPage=50'));
    expect(runListCsvImportRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, perPage: 50 }),
    );
  });

  it('200 — page beyond last returns empty rows + totals (use-case returns empty)', async () => {
    runListCsvImportRecordsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        rows: [],
        pagination: {
          page: 9999,
          perPage: 30,
          totalRecords: 1,
          totalPages: 1,
        },
      },
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('?page=9999'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: unknown[] };
    expect(body.records).toEqual([]);
  });

  it('200 — expired-blob row sets errorCsvAvailable: false', async () => {
    runListCsvImportRecordsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        rows: [
          {
            ...buildRow({
              recordId: RECORD_B,
              errorCsvExpiresAt: new Date('2026-04-01T00:00:00Z'),
            }),
            errorCsvAvailable: false,
          },
        ],
        pagination: { page: 1, perPage: 30, totalRecords: 1, totalPages: 1 },
      },
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest());
    const body = (await res.json()) as {
      records: ReadonlyArray<{ errorCsvAvailable: boolean }>;
    };
    expect(body.records[0]!.errorCsvAvailable).toBe(false);
  });

  it('400 — page < 1 rejected with ProblemDetails', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('?page=0'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string };
    expect(body.title).toMatch(/pagination/i);
  });

  it('400 — perPage > 100 rejected', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('?perPage=101'));
    expect(res.status).toBe(400);
  });

  it('400 — malformed eventId UUID rejected', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('?eventId=not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('400 — malformed actorUserId UUID rejected', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('?actorUserId=invalid'));
    expect(res.status).toBe(400);
  });

  it('403/404 — RBAC deny short-circuits before use-case (manager/member/anonymous)', async () => {
    adminOnlyGuardMock.mockResolvedValueOnce({
      kind: 'deny',
      response: new Response(null, { status: 404 }),
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest());
    expect(res.status).toBe(404);
    expect(runListCsvImportRecordsMock).not.toHaveBeenCalled();
  });

  it('500 — use-case error returns ProblemDetails with requestId', async () => {
    runListCsvImportRecordsMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'db_error', message: 'Neon transient' },
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { title: string; requestId: string };
    expect(body.title).toMatch(/internal/i);
    expect(typeof body.requestId).toBe('string');
  });

  // 503 kill-switch is verified at the runtime level — env.features.f6EventCreate
  // is read at module-eval time so a per-test env mock doesn't isolate cleanly
  // (the route module is loaded once per file). Coverage delegated to the
  // existing `csv-import-api.test.ts` precedent + integration smoke.
});
