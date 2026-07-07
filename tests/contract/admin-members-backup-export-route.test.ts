/**
 * Contract test — GET /api/admin/members/export.zip (design 2026-07-07).
 * Pins the route's wire-level concerns: RBAC guard forwarding, admin-only
 * policy args ('members:bulk' + 'write'), success headers (zip content-type,
 * attachment disposition, no-store, per-file row-count headers), forbidden →
 * 404 cloak, gather_failed → 500.
 *
 * Mock policy: vi.mock at the auth/infra/use-case seams only — the route's
 * own code (header construction, error mapping) runs unmodified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireAdminContextMock = vi.fn();
const exportMembersBackupMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-backup-1',
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/insights', () => ({
  exportMembersBackup: (...args: unknown[]) => exportMembersBackupMock(...args),
  makeExportMembersBackupDeps: () => ({}),
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'admin@swecham.test', role: 'admin', status: 'active', displayName: 'Admin' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-backup-1',
};

async function callRoute(): Promise<Response> {
  const { GET } = await import('@/app/api/admin/members/export.zip/route');
  return GET(new NextRequest('http://localhost:3100/api/admin/members/export.zip', { method: 'GET' }));
}

describe('GET /api/admin/members/export.zip — route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminContextMock.mockResolvedValue(adminContext);
    exportMembersBackupMock.mockResolvedValue({
      ok: true,
      value: {
        zip: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        filename: 'test-swecham-members-backup-20260707-1730.zip',
        rowCounts: { members: 2, contacts: 3, invoices: 4 },
      },
    });
  });
  afterEach(() => vi.resetModules());

  it('guard rejection is forwarded verbatim (guard called with members:bulk/write)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(requireAdminContextMock).toHaveBeenCalledWith(
      expect.anything(),
      { resource: 'members:bulk', action: 'write' },
    );
    expect(exportMembersBackupMock).not.toHaveBeenCalled();
  });

  it('admin happy path → 200 zip with attachment headers + row counts', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain(
      'test-swecham-members-backup-20260707-1730.zip',
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('X-Members-Count')).toBe('2');
    expect(res.headers.get('X-Contacts-Count')).toBe('3');
    expect(res.headers.get('X-Invoices-Count')).toBe('4');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]); // 'PK\x03\x04'
  });

  it("use-case 'forbidden' → 404 cloak", async () => {
    exportMembersBackupMock.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("use-case 'gather_failed' → 500 server_error", async () => {
    exportMembersBackupMock.mockResolvedValueOnce({ ok: false, error: 'gather_failed' });
    const res = await callRoute();
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('server_error');
  });
});
