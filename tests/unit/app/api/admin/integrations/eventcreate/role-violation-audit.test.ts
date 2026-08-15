/**
 * 016 post-ship review findings #4 + #7 — the eventcreate _lib guard.
 *
 * #4: `emitIntegrationRoleViolation` used a bare `await deps.emitStandalone(…)`
 * inside try/catch — a RETURNED-err Result (db_error / audit_emit, not a
 * throw) silently lost the forensic role_violation_blocked row with zero log
 * signal, while the events/_lib twin checked the Result. Pins the check.
 *
 * #7: every denial with a resolved session must increment the org-wide
 * rbac_permission_denied_total series (dashboards were blind to
 * /api/admin/integrations/eventcreate/** denials).
 *
 * Harness mirrors tests/unit/app/api/admin/events/_lib/
 * admin-only-writer-guard.test.ts (cold module graph paid in beforeAll).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NextRequest } from 'next/server';

const getCurrentSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitStandaloneMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerErrorMock = vi.fn();
const permissionDeniedMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>(
    '@/modules/events',
  );
  return {
    ...actual,
    makeStandaloneAuditDeps: () => ({
      emitStandalone: (...args: unknown[]) => emitStandaloneMock(...args),
    }),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    authMetrics: {
      ...actual.authMetrics,
      permissionDenied: (...args: unknown[]) => permissionDeniedMock(...args),
    },
  };
});

const TENANT_SLUG = 'test-swecham';

beforeAll(async () => {
  await import('@/app/api/admin/integrations/eventcreate/_lib/role-violation-audit');
}, 60_000);

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadLib() {
  return await import(
    '@/app/api/admin/integrations/eventcreate/_lib/role-violation-audit'
  );
}

function buildRequest(): NextRequest {
  return new NextRequest('http://test/api/admin/integrations/eventcreate/config', {
    method: 'POST',
  });
}

const baseInput = {
  permissionKey: 'settings.integrations',
  attemptedRoute: '/api/admin/integrations/eventcreate/config',
  attemptedAction: 'update_config',
} as const;

describe('emitIntegrationRoleViolation — returned-err Result is logged (finding #4)', () => {
  it('emitStandalone {ok:false} → f6_role_violation_audit_emit_failed error log', async () => {
    emitStandaloneMock.mockResolvedValue({ ok: false, error: { kind: 'db_error' } });
    const { emitIntegrationRoleViolation } = await loadLib();
    await emitIntegrationRoleViolation(buildRequest(), {
      actorUserId: 'mbr-1',
      actorRole: 'member',
      attemptedRoute: baseInput.attemptedRoute,
      attemptedAction: baseInput.attemptedAction,
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_role_violation_audit_emit_failed',
        err: 'db_error',
        actorRole: 'member',
        attemptedRoute: baseInput.attemptedRoute,
      }),
      expect.any(String),
    );
  });

  it('emitStandalone {ok:true} → no error log', async () => {
    const { emitIntegrationRoleViolation } = await loadLib();
    await emitIntegrationRoleViolation(buildRequest(), {
      actorUserId: 'mbr-1',
      actorRole: 'member',
      attemptedRoute: baseInput.attemptedRoute,
      attemptedAction: baseInput.attemptedAction,
    });
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('emitStandalone THROW keeps the legacy f6_audit_emit_failed arm', async () => {
    emitStandaloneMock.mockRejectedValue(new Error('boom'));
    const { emitIntegrationRoleViolation } = await loadLib();
    await emitIntegrationRoleViolation(buildRequest(), {
      actorUserId: null,
      actorRole: 'manager',
      attemptedRoute: baseInput.attemptedRoute,
      attemptedAction: baseInput.attemptedAction,
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_audit_emit_failed' }),
      expect.any(String),
    );
  });
});

describe('adminOnlyGuard — org-wide denial metric (finding #7)', () => {
  it('known-role denial increments with role + permission and still 404s', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'mbr-1', role: 'member' as const, email: 'mb@t' },
    });
    const { adminOnlyGuard } = await loadLib();
    const result = await adminOnlyGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') expect(result.response.status).toBe(404);
    expect(permissionDeniedMock).toHaveBeenCalledWith({
      role: 'member',
      permission: 'settings.integrations',
    });
    expect(emitStandaloneMock).toHaveBeenCalled();
  });

  it('unknown role string increments with the RAW string, warn log, no audit row', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'unk-1', role: 'superadmin' as unknown as 'member', email: 'u@t' },
    });
    const { adminOnlyGuard } = await loadLib();
    const result = await adminOnlyGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    expect(permissionDeniedMock).toHaveBeenCalledWith({
      role: 'superadmin',
      permission: 'settings.integrations',
    });
    expect(emitStandaloneMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_integration_guard_role_denied_unattributable',
        role: 'superadmin',
      }),
      expect.any(String),
    );
  });

  it('allow and no-session never increment', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'sa-1', role: 'super_admin' as const, email: 'sa@t' },
    });
    const { adminOnlyGuard } = await loadLib();
    const allowed = await adminOnlyGuard(buildRequest(), baseInput);
    expect(allowed.kind).toBe('allow');
    getCurrentSessionMock.mockResolvedValue(null);
    const anon = await adminOnlyGuard(buildRequest(), baseInput);
    expect(anon.kind).toBe('deny');
    expect(permissionDeniedMock).not.toHaveBeenCalled();
  });
});
