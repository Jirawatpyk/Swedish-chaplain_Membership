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

// 016 post-ship finding #7 — the guard now feeds the org-wide denial metric.
const permissionDeniedMock = vi.fn();
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
const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'admin' as const, email: 'a@t' },
};
const MANAGER_SESSION = {
  user: { id: 'mgr-1', role: 'manager' as const, email: 'm@t' },
};
const MEMBER_SESSION = {
  user: { id: 'mbr-1', role: 'member' as const, email: 'mb@t' },
};

/**
 * Pay the cold module-graph cost ONCE, inside the hook budget.
 *
 * The first `it()` in this file was importing the whole Next.js server graph
 * itself and charging it to the 30 s TEST timeout — 27 s solo, and over the
 * line whenever a sibling file was competing for CPU. That is an intermittent
 * red on `Unit + contract`, which is a required check on `main`, and
 * intermittent is worse than broken because it trains people to re-run.
 *
 * `vitest.config.ts` sets `hookTimeout` to double `testTimeout` for exactly
 * this, and states outright that raising `testTimeout` again is not the answer
 * ("the treadmill this repo is already on — 5s → 10s → 30s").
 */
beforeAll(async () => {
  await import('@/app/api/admin/events/_lib/role-violation-audit');
}, 60_000);

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Cold module graph is paid in beforeAll; `loadGuard` stays a plain import.
 * The leg switch that used to live here (mutable env state + resetModules per
 * case) died with the legacy leg in PR 5 — there is one evaluator now.
 */
async function loadGuard() {
  return await import('@/app/api/admin/events/_lib/role-violation-audit');
}

function buildRequest(): NextRequest {
  return new NextRequest('http://test/api/admin/events/some/relink', {
    method: 'POST',
  });
}

const baseInput = {
  // 016 T029 — the guard evaluates the route's flag-ON key through the
  // evaluator (legacyF6Guard row on the OFF leg); denial SHAPES stay D9.
  permissionKey: 'events.write',
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

  it('016 T029 — super_admin → allow; the literal admin check 404ed every promoted super_admin post-Migration-C', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'sa-1', role: 'super_admin' as const, email: 'sa@t' },
    });
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.actorUserId).toBe('sa-1');
    }
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  /**
   * Marketing is the one role whose answer here DIFFERS BY LEG, so both are
   * pinned. The guard admits via `canPerform(role, input.permissionKey,
   * legacyF6Guard)` and `baseInput.permissionKey` is `events.write`:
   *
   *  - ON leg (production since the 2026-08-11 cutover, and the code default
   *    since T066): `events.write` is in the marketing bundle → ALLOW. That is
   *    the design, not a leak — spec.md § Clarifications reads "events RW
   *    (excluding attendee-PII erasure and registration relink)", tasks.md T029
   *    states "PR 4 grants marketing `events.write` without touching the
   *    guards", and the frozen contract matrix lists POST /api/admin/events,
   *    …/archive, …/toggle-*, …/import under `MARKETING_REACHABLE`. The two
   *    exclusions are separate keys and stay denied — asserted below.
   *  - OFF leg: D16 maps marketing to no legacy role, so the shim denies it
   *    everywhere under /admin — one of the five fold decisions the maintainer
   *    confirmed on 2026-08-10 ("marketing denied on legacy leg"). PR 5 deletes
   *    this arm along with the leg.
   *
   * The T033 claim — a denial records the LITERAL role rather than collapsing
   * it to a legacy one — is carried by the OFF-leg case here and by the
   * `member` case below, which is denied on both legs.
   */
  it('016 T029 — marketing → ALLOW on the ON leg (events RW is its scope)', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'mk-1', role: 'marketing' as const, email: 'mk@t' },
    });
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.actorUserId).toBe('mk-1');
    }
    expect(emitStandaloneMock, 'an allowed write is not a role violation').not.toHaveBeenCalled();
  });

  it('016 T029 — marketing is still DENIED the two carved-out event keys on the ON leg', async () => {
    // Without this, "marketing → allow" could be read as "marketing → allow
    // everything under /admin/events", which is exactly what the spec excludes.
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'mk-1', role: 'marketing' as const, email: 'mk@t' },
    });
    const { adminOnlyWriterGuard } = await loadGuard();
    for (const permissionKey of ['events.relink', 'events.erasure'] as const) {
      emitStandaloneMock.mockClear();
      const result = await adminOnlyWriterGuard(buildRequest(), { ...baseInput, permissionKey });
      expect(result.kind, `${permissionKey} must stay denied for marketing`).toBe('deny');
      if (result.kind === 'deny') {
        expect(result.response.status).toBe(404);
      }
      const entry = emitStandaloneMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(entry?.['actorType']).toBe('marketing');
    }
  });

  // The OFF-leg marketing deny case died with the legacy leg in PR 5 — the
  // fold decision it pinned ("marketing denied on legacy leg") is history.
  // T033's LITERAL-role audit attribution is carried by the carve-out case
  // above and the member case below.

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

/**
 * 016 post-ship review finding #7 — F6 keeps role_violation_blocked as its
 * audit vocabulary, but every denial must ALSO increment the org-wide
 * rbac_permission_denied_total series (dashboards were blind to
 * /api/admin/events/** denials). No-session and allow stay metric-free:
 * the org gate 401s before permission evaluation, so no denial happened.
 */
describe('adminOnlyWriterGuard — org-wide denial metric (finding #7)', () => {
  it('manager denial increments with the raw role + permission key', async () => {
    getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(permissionDeniedMock).toHaveBeenCalledWith({
      role: 'manager',
      permission: 'events.write',
    });
  });

  it('member denial increments', async () => {
    getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(permissionDeniedMock).toHaveBeenCalledWith({
      role: 'member',
      permission: 'events.write',
    });
  });

  it('unknown role string increments with the RAW string (never coerced)', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'unk-1', role: 'superadmin' as unknown as 'member', email: 'u@t' },
    });
    const { adminOnlyWriterGuard } = await loadGuard();
    await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(permissionDeniedMock).toHaveBeenCalledWith({
      role: 'superadmin',
      permission: 'events.write',
    });
  });

  it('allow and no-session never increment', async () => {
    getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
    const { adminOnlyWriterGuard } = await loadGuard();
    await adminOnlyWriterGuard(buildRequest(), baseInput);
    getCurrentSessionMock.mockResolvedValue(null);
    await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(permissionDeniedMock).not.toHaveBeenCalled();
  });
});

/**
 * Twin of the eventcreate finding #4 pin — this copy always checked the
 * emitStandalone Result; keep it pinned so the two _lib copies cannot
 * drift apart again.
 */
describe('emitEventsRoleViolation — returned-err Result is logged (finding #4 twin)', () => {
  it('emitStandalone {ok:false} → f6_role_violation_audit_emit_failed, denial still served', async () => {
    getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
    emitStandaloneMock.mockResolvedValue({ ok: false, error: { kind: 'db_error' } });
    const { adminOnlyWriterGuard } = await loadGuard();
    const result = await adminOnlyWriterGuard(buildRequest(), baseInput);
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') expect(result.response.status).toBe(403);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_role_violation_audit_emit_failed',
        err: 'db_error',
      }),
      expect.any(String),
    );
  });
});
