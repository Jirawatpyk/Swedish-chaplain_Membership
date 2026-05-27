/**
 * F9 US2 (Round-2 review) — contract test for `GET /api/admin/audit/export.csv`.
 *
 * The route's wire-level concerns have no other coverage (the `auditExport`
 * use-case is covered by the insights contract/integration tests, but the
 * route's flag-gate, role-gate, rate-limit, date-format guard, error mapping,
 * CSV framing + formula-neutralisation, and BOM survival are route-only).
 *
 * Mock policy: mock the auth/infra/use-case seams only — the route's own code
 * path (URL parse, isYmd guard, header construction, toCsvField over rows) runs
 * unmodified, so `@/lib/csv` + `@/lib/tenant-day-range` + `@/lib/content-disposition`
 * stay REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireSessionMock = vi.fn();
const auditExportMock = vi.fn();
const rateLimiterCheckMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  requireSession: (...a: unknown[]) => requireSessionMock(...a),
}));
vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: true }, tenant: { timezone: 'Asia/Bangkok' } },
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham' }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-audit-export-1' }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/auth', () => ({
  rateLimiter: { check: (...a: unknown[]) => rateLimiterCheckMock(...a) },
}));
vi.mock('@/modules/insights', () => ({
  auditExport: (...a: unknown[]) => auditExportMock(...a),
  makeAuditQueryDeps: () => ({}),
}));

const adminSession = { user: { id: 'admin-1', role: 'admin' }, session: { id: 's1' } };

function okRl() {
  return { success: true, remaining: 9, reset: Date.now() + 60_000, fellBack: false };
}

async function callRoute(qs: string): Promise<Response> {
  const { GET } = await import('@/app/api/admin/audit/export.csv/route');
  return GET(new NextRequest(`http://localhost:3100/api/admin/audit/export.csv${qs}`, { method: 'GET' }));
}

describe('GET /api/admin/audit/export.csv — route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMock.mockResolvedValue(adminSession);
    rateLimiterCheckMock.mockResolvedValue(okRl());
  });
  afterEach(() => vi.resetModules());

  it('non-staff role → 403 (does not dispatch)', async () => {
    requireSessionMock.mockResolvedValueOnce({ user: { id: 'm1', role: 'member' }, session: {} });
    const res = await callRoute('');
    expect(res.status).toBe(403);
    expect(auditExportMock).not.toHaveBeenCalled();
  });

  it('rate-limited → 429 + Retry-After (does not dispatch)', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, remaining: 0, reset: Date.now() + 30_000, fellBack: false });
    const res = await callRoute('');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(auditExportMock).not.toHaveBeenCalled();
  });

  it('malformed `from` → 400 invalid_range BEFORE js-joda conversion (does not dispatch)', async () => {
    const res = await callRoute('?from=garbage');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range');
    expect(auditExportMock).not.toHaveBeenCalled();
  });

  it('shape-valid but IMPOSSIBLE date (2026-02-30) → 400 (not a 500 from js-joda throw)', async () => {
    // isYmd must calendar-validate — else tenantDayStartUtc throws OUTSIDE the
    // try/catch → bodyless 500. Assert the clean 400 + no dispatch.
    const res = await callRoute('?from=2026-02-30&to=2026-03-01');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range');
    expect(auditExportMock).not.toHaveBeenCalled();
  });

  it('use-case forbidden → 403; too_large → 409; invalid_range → 400', async () => {
    auditExportMock.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect((await callRoute('')).status).toBe(403);
    auditExportMock.mockResolvedValueOnce({ ok: false, error: 'export_too_large' });
    expect((await callRoute('')).status).toBe(409);
    auditExportMock.mockResolvedValueOnce({ ok: false, error: 'invalid_range' });
    expect((await callRoute('')).status).toBe(400);
  });

  it('success → 200, CSV with UTF-8 BOM + headers + formula-neutralised cell', async () => {
    auditExportMock.mockResolvedValueOnce({
      ok: true,
      value: {
        rows: [
          {
            id: 'a',
            occurredAt: '2026-05-20T10:00:00.000Z',
            eventType: 'role_changed',
            actorLabel: 'Jane',
            actorUserId: 'actor-1',
            targetUserId: null,
            summary: '=cmd()', // formula-injection attempt
            payload: { from: 'member', to: 'manager' },
          },
        ],
      },
    });
    const res = await callRoute('?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-row-count')).toBe('1');
    expect((res.headers.get('content-disposition') ?? '').toLowerCase()).toContain('attachment');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    const decoded = new TextDecoder('utf-8').decode(bytes);
    expect(decoded).toContain(`"'=cmd()"`); // neutralised (leading quote)
    expect(decoded).not.toContain(',=cmd()'); // never a bare formula cell
  });

  it('flag off → 404 (does not dispatch)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', () => ({
      env: { features: { f9Dashboard: false }, tenant: { timezone: 'Asia/Bangkok' } },
    }));
    const { GET } = await import('@/app/api/admin/audit/export.csv/route');
    const res = await GET(
      new NextRequest('http://localhost:3100/api/admin/audit/export.csv', { method: 'GET' }),
    );
    expect(res.status).toBe(404);
    expect(auditExportMock).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/env');
  });
});
