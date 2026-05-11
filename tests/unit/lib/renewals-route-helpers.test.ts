/**
 * F8 Phase 6 review I8 — RBAC contract for `requireRenewalAdminContext`.
 *
 * Pins the role × action matrix (FR-052a) for all at-risk admin routes:
 *
 *   action            admin   manager   member
 *   ─────────────────────────────────────────────
 *   read              ✓       ✓         403
 *   write             ✓       403       403
 *   manager_exception ✓       ✓         403
 *
 * Plus the C5+I5 audit emit invariant: every 403 path MUST fire
 * `f8_role_violation_blocked` with the actual `action` label
 * preserved (not flattened to 'read').
 *
 * Covers the 3 at-risk admin routes:
 *   - GET  /api/admin/renewals/at-risk           → 'read'
 *   - POST /api/admin/renewals/at-risk/[id]/snooze → 'write'
 *   - POST /api/admin/renewals/at-risk/[id]/outreach → 'manager_exception'
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const TENANT_SLUG = 'tenanta';

vi.mock('@/lib/env', () => ({
  env: {
    features: { f8Renewals: true },
    tenant: { slug: 'tenanta' },
    database: { url: 'postgres://stub:stub@localhost/stub' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: vi.fn(() => ({ slug: 'tenanta' })),
}));

const getCurrentSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: getCurrentSessionMock,
}));

const requireRoleMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rbac-guard', () => ({
  requireRole: requireRoleMock,
}));

const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_e: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: TENANT_SLUG },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
}));

import { requireRenewalAdminContext } from '@/lib/renewals-route-helpers';

function makeRequest(pathname = '/api/admin/renewals/at-risk'): NextRequest {
  return {
    headers: { get: () => null },
    url: `http://localhost:3100${pathname}`,
  } as unknown as NextRequest;
}

function mockSession(role: 'admin' | 'manager' | 'member') {
  getCurrentSessionMock.mockResolvedValueOnce({
    user: { id: '00000000-0000-0000-0000-00000000a001', role },
  });
}

describe('requireRenewalAdminContext (Phase 6 review I8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- 'read' action ---------------------------------------------------
  it("admin + 'read' → context returned", async () => {
    mockSession('admin');
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    const result = await requireRenewalAdminContext(makeRequest(), 'read');
    expect('current' in result).toBe(true);
    if ('current' in result) {
      expect(result.current.user.role).toBe('admin');
    }
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it("manager + 'read' → context returned (FR-052a manager full-read)", async () => {
    mockSession('manager');
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    const result = await requireRenewalAdminContext(makeRequest(), 'read');
    expect('current' in result).toBe(true);
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it("member + 'read' → 403 + f8_role_violation_blocked audit", async () => {
    mockSession('member');
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });
    const result = await requireRenewalAdminContext(makeRequest(), 'read');
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(403);
    }
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('f8_role_violation_blocked');
    expect((event.payload as { action: string }).action).toBe('read');
    expect((event.payload as { attempted_role: string }).attempted_role).toBe(
      'member',
    );
  });

  // --- 'write' action --------------------------------------------------
  it("admin + 'write' → context returned", async () => {
    mockSession('admin');
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    const result = await requireRenewalAdminContext(
      makeRequest('/api/admin/renewals/at-risk/m1/snooze'),
      'write',
    );
    expect('current' in result).toBe(true);
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it("manager + 'write' → 403 + audit (FR-052a manager denied write)", async () => {
    mockSession('manager');
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });
    const result = await requireRenewalAdminContext(
      makeRequest('/api/admin/renewals/at-risk/m1/snooze'),
      'write',
    );
    expect('response' in result).toBe(true);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('f8_role_violation_blocked');
    expect((event.payload as { action: string }).action).toBe('write');
    expect((event.payload as { attempted_role: string }).attempted_role).toBe(
      'manager',
    );
  });

  // --- 'manager_exception' action (Phase 6 review I5) ------------------
  it("admin + 'manager_exception' → context returned (mapped to 'read' RBAC)", async () => {
    mockSession('admin');
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    const result = await requireRenewalAdminContext(
      makeRequest('/api/admin/renewals/at-risk/m1/outreach'),
      'manager_exception',
    );
    expect('current' in result).toBe(true);
    // RBAC layer received the mapped 'read' label.
    expect(requireRoleMock).toHaveBeenCalledWith(
      expect.anything(),
      'renewal',
      'read',
      expect.anything(),
    );
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it("manager + 'manager_exception' → context returned (FR-052a outreach exception)", async () => {
    mockSession('manager');
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    const result = await requireRenewalAdminContext(
      makeRequest('/api/admin/renewals/at-risk/m1/outreach'),
      'manager_exception',
    );
    expect('current' in result).toBe(true);
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it("member + 'manager_exception' → 403 + audit with action='manager_exception' (NOT 'read')", async () => {
    mockSession('member');
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });
    const result = await requireRenewalAdminContext(
      makeRequest('/api/admin/renewals/at-risk/m1/outreach'),
      'manager_exception',
    );
    expect('response' in result).toBe(true);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('f8_role_violation_blocked');
    // I5 fix — audit preserves the actual semantic label so dashboards
    // distinguish a manager-exception write attempt from a pure read.
    expect((event.payload as { action: string }).action).toBe(
      'manager_exception',
    );
  });

  // --- 401 path --------------------------------------------------------
  it('no session → 401 (no audit emit)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);
    const result = await requireRenewalAdminContext(makeRequest(), 'read');
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(401);
    }
    // No actor identity → no audit signal.
    expect(auditEmitMock).not.toHaveBeenCalled();
  });
});
