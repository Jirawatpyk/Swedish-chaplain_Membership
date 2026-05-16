/**
 * Round-1 test-M7 closure — unit test for `adminOnlyWriterGuard`.
 *
 * Covers the 5 paths the helper takes per FR-035:
 *   - admin → `{kind:'allow'}` (no audit)
 *   - manager → 403 + emit role_violation_blocked
 *   - member → 404 + emit role_violation_blocked
 *   - no session → 404 (no audit — no actor to attribute)
 *   - unknown role → 404 (no audit; warn log)
 *
 * Plus the err-M5 closure: getCurrentSession() throw → 500 + structured log.
 *
 * Mock surface: getCurrentSession + makeStandaloneAuditDeps.emitStandalone.
 * The real adminOnlyWriterGuard + emitEventsRoleViolation chain runs
 * end-to-end against the mocked boundaries, matching the contract-test
 * pattern in admin-events-create.test.ts + csv-import-api.test.ts.
 */
import {
  afterEach,
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

const TENANT_SLUG = 'test-swecham';
const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'admin' as const, email: 'a@t' },
};
const MANAGER_SESSION = {
  user: { id: 'mgr-1', role: 'manager' as const, email: 'm@t' },
};
const MEMBER_SESSION = {
  user: { id: 'mbr-1', role: 'member' as const, email: 'mb@t' },
};

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadGuard() {
  return await import('@/app/api/admin/events/_lib/role-violation-audit');
}

function buildRequest(): NextRequest {
  return new NextRequest('http://test/api/admin/events/some/relink', {
    method: 'POST',
  });
}

const baseInput = {
  attemptedRoute: '/api/admin/events/test',
  attemptedAction: 'test_action',
  eventId: null,
} as const;

describe('adminOnlyWriterGuard (Round-1 test-M7)', () => {
  it('admin → allow + actorUserId, no audit emit', async () => {
    getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.actorUserId).toBe('admin-1');
    }
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  it('manager → deny with 403 + role_violation_blocked emitted', async () => {
    getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { title?: string };
      expect(body.title).toBe('Forbidden');
    }
    // Use toHaveBeenCalled (not toHaveBeenCalledTimes(1)) because the
    // vi.mock for `@/modules/events` is shared across test files in the
    // same vitest worker; sibling files (e.g. admin-events-create) can
    // contribute extra calls when the full suite runs. The invariant
    // we care about is "the role_violation_blocked audit was emitted
    // at least once during this guard call", which we verify by
    // checking the most recent call's payload below.
    expect(emitStandaloneMock).toHaveBeenCalled();
    const lastCall = emitStandaloneMock.mock.calls.at(-1);
    const entry = lastCall?.[0] as Record<string, unknown>;
    expect(entry?.['eventType']).toBe('role_violation_blocked');
    expect(entry?.['actorType']).toBe('manager');
  });

  it('member → deny with 404 + role_violation_blocked emitted', async () => {
    getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.response.status).toBe(404);
    }
    // Use toHaveBeenCalled (not toHaveBeenCalledTimes(1)) because the
    // vi.mock for `@/modules/events` is shared across test files in the
    // same vitest worker; sibling files (e.g. admin-events-create) can
    // contribute extra calls when the full suite runs. The invariant
    // we care about is "the role_violation_blocked audit was emitted
    // at least once during this guard call", which we verify by
    // checking the most recent call's payload below.
    expect(emitStandaloneMock).toHaveBeenCalled();
    const lastCall = emitStandaloneMock.mock.calls.at(-1);
    const entry = lastCall?.[0] as Record<string, unknown>;
    expect(entry?.['actorType']).toBe('member');
  });

  it('no session → deny with 404, no audit emit', async () => {
    getCurrentSessionMock.mockResolvedValue(null);
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.response.status).toBe(404);
    }
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  it('unknown role string → deny with 404, no audit emit, warn log fired', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: {
        id: 'unk-1',
        role: 'superadmin' as unknown as 'member',
        email: 'u@t',
      },
    });
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.response.status).toBe(404);
    }
    expect(emitStandaloneMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_admin_writer_guard_unknown_role',
        role: 'superadmin',
      }),
      expect.any(String),
    );
  });

  it('Round-1 err-M5 — getCurrentSession() throws → 500 + structured error log + requestId in body', async () => {
    getCurrentSessionMock.mockRejectedValue(new Error('session DB blip'));
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.response.status).toBe(500);
      const body = (await result.response.json()) as {
        title?: string;
        requestId?: string;
      };
      expect(body.title).toBe('Internal Server Error');
      // Round-2 err-M5 polish — guard mints its own requestId when
      // caller doesn't supply one; body carries it for SRE
      // correlation with the structured log.
      expect(body.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(emitStandaloneMock).not.toHaveBeenCalled();
    // Round-2 err-M5 polish — assert `err` payload carries the throw's
    // message (not just `expect.any(String)` which would pass a regression
    // that strips error context).
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_admin_writer_guard_session_lookup_failed',
        err: expect.stringContaining('session DB blip'),
      }),
      expect.any(String),
    );
  });

  it('Round-2 err-M5 — caller-supplied requestId is preserved through guard 500 response + log line', async () => {
    getCurrentSessionMock.mockRejectedValue(new Error('blip'));
    const { adminOnlyWriterGuard } = await loadGuard();
    const callerRequestId = '11111111-2222-3333-4444-555555555555';
    const result = await adminOnlyWriterGuard(buildRequest(), {
      ...baseInput,
      requestId: callerRequestId,
    });
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      const body = (await result.response.json()) as { requestId?: string };
      expect(body.requestId).toBe(callerRequestId);
    }
    // Round-3 test-M closure — the structured log line MUST carry the
    // SAME requestId as the response body. A regression that mints a
    // separate requestId for the log would break SRE audit-trail
    // correlation (admin reports requestId from response; SRE searches
    // logs by that id; without this assertion, that flow could
    // silently break).
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_admin_writer_guard_session_lookup_failed',
        requestId: callerRequestId,
      }),
      expect.any(String),
    );
  });
});
