/**
 * T053 — Contract test: GET /api/admin/events + GET /api/admin/events/[eventId]
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/admin-events-api.md
 *   - FR-020 (list), FR-021 (detail), FR-035 (RBAC + surface disclosure)
 *
 * Exercises the GET-list + GET-detail contract:
 *   • query-param defaults + bounds + filter combinations
 *   • response envelope shape (items / pagination / emptyStateContext)
 *   • 3-variant emptyStateContext payload always returned
 *   • paginated registrations + match-rate aggregate on detail
 *   • FR-035 surface-disclosure: member role → 404 (not 403) + audit emit
 *   • 404 for missing event id OR cross-tenant id (use-case returns null
 *     ⇒ route maps to 404 with no event-id echo)
 *   • Audit-failure tolerance (E4 verify-fix): 404 still fires when
 *     audit emit throws + the failure is logged via `logger.error`.
 *
 * Pattern mirrors tests/contract/events/webhook-eventcreate-v1.test.ts —
 * module-boundary mocks for `@/modules/events` use-cases so no DB, no
 * tenant resolution, no auth infrastructure is hit. Each test stubs the
 * use-case return value.
 *
 * History: authored RED in T053 (commit cf44b978); turned GREEN by
 * T057+T058+T060 (commits 15355361 + fbc73e40). Audit-emit assertions
 * added in F1+F2 verify-fix (commit 9491f714). E4 logger.error spy
 * added in this verify-review fix sweep.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
// T9 fix: type-only imports to constrain the
// mock factories against the REAL adapter signatures. A future refactor
// that adds a third arg to runListEvents/runLoadEventDetail breaks the
// test at compile time before it can ship as a silent prod regression.
import type {
  runListEvents,
  runLoadEventDetail,
} from '@/lib/events-admin-deps';
import type {
  EventId,
  RegistrationId,
  AttendeeEmail,
} from '@/modules/events';
import type { MemberId, ContactId } from '@/modules/members';

// Helpers — fixture casts so the wire-format brand narrowing satisfies
// the typed mock signatures without manual `as` clutter at each site.
const evtId = (s: string) => s as EventId;
const regId = (s: string) => s as RegistrationId;
const attEmail = (s: string) => s as AttendeeEmail;
const memId = (s: string) => s as MemberId;
const conId = (s: string) => s as ContactId;

// ---------------------------------------------------------------------------
// Mock seams — replace heavy dependencies at module boundary.
// ---------------------------------------------------------------------------

// T9 fix: mocks typed against the real
// exported signatures so a future refactor that changes the arg list
// breaks tests at compile time, not at runtime.
const listEventsMock = vi.fn<typeof runListEvents>();
const loadEventDetailMock = vi.fn<typeof runLoadEventDetail>();
// R003 (staff-review fix 2026-05-13): routes now call `getCurrentSession`
// (returns null on no-session, throws on infra failure) instead of
// `requireSession(...).catch(() => null)` (swallowed all errors as null).
// The shared mock fn drives BOTH exports because both spellings are
// referenced by route handlers across F6 surfaces — list+detail routes
// use getCurrentSession; the page server component still uses
// requireSession. Tests that previously asserted "auth throw → 404"
// (the swallowed-error behaviour) are updated below to assert the
// distinct null-vs-throw paths separately.
const getCurrentSessionMock = vi.fn();
const requireSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitStandaloneMock = vi.fn();

// T12 fix (2026-05-12): explicit factory listing only the specific
// exports the route consumes from the barrel, instead of
// `vi.importActual('@/modules/events')` which re-resolved the entire
// barrel (~25 exports) per test and was the suspected cause of the
// 7s isolated / 30s parallel-flake reported in verify-review.
//
// Route imports from `@/modules/events` that need stubbing:
//   • `MATCH_TYPES` (detail route enum-validation)
//   • `makeStandaloneAuditDeps` (FR-035 audit emit)
//
// `isMatchType` is consumed only by the PAGE component, not the route —
// listed in the comment for completeness but not stubbed here.
//
// `MATCH_TYPES` is a literal const — duplicated explicitly here so the
// factory is pure data, no async resolution. `isMatchType` is a pure
// predicate over that const.
const MATCH_TYPES = [
  'member_contact',
  'member_domain',
  'member_fuzzy',
  'non_member',
  'unmatched',
] as const;

// M-B round-3 fix (2026-05-12): compile-time anchor against the real
// Domain const. Type-only import (erased at runtime — no perf cost).
// If `src/modules/events/domain/value-objects/match-type.ts` adds a
// 6th MatchType (e.g. `'duplicate_registration'`), the type-assertion
// below FAILS TO COMPILE — surfacing the drift instead of silently
// shipping a test fixture that lies about the Domain shape.
import type { MATCH_TYPES as RealMatchTypes } from '@/modules/events';
const _matchTypesDriftAnchor: typeof RealMatchTypes = MATCH_TYPES;
void _matchTypesDriftAnchor;
vi.mock('@/modules/events', () => ({
  MATCH_TYPES,
  isMatchType: (v: unknown): v is (typeof MATCH_TYPES)[number] =>
    typeof v === 'string' &&
    (MATCH_TYPES as readonly string[]).includes(v),
  // F1 fix: stub makeStandaloneAuditDeps so the route's audit emit
  // path is observable (FR-035 mandate) without hitting a real DB.
  makeStandaloneAuditDeps: () => ({
    emitStandalone: (...args: unknown[]) => emitStandaloneMock(...args),
  }),
}));

// Mock the composition adapter (route handler's only DB seam) so no
// Drizzle pool / Neon connection is required. The `run*` wrappers stub
// `runInTenant(...)` + use-case dispatch in one call — the test
// controls the result by injecting fake Result objects via the
// `listEventsMock` / `loadEventDetailMock` factories so we can also
// observe the input arguments (the route's parsed params).
vi.mock('@/lib/events-admin-deps', () => ({
  runListEvents: (...args: Parameters<typeof runListEvents>) =>
    listEventsMock(...args),
  runLoadEventDetail: (...args: Parameters<typeof runLoadEventDetail>) =>
    loadEventDetailMock(...args),
}));

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
  requireSession: (...args: unknown[]) => requireSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

const TENANT_SLUG = 'test-swecham';

// Staff-review R3 follow-up (2026-05-16): pre-warm both route modules
// so the first test does not pay the cold-start dynamic-import cost
// (~10-15s in normal mode, 2-3× higher under `pnpm test:coverage`
// instrumentation). Under parallel coverage runs the first test's
// duration was racing the global 30s testTimeout (vitest.config.ts:50)
// and intermittently failing. `beforeAll` runs once per file and the
// imported module is cached, so all subsequent test cases pay only
// the call-handler cost (~50-200ms each).
beforeAll(async () => {
  await Promise.all([loadListRoute(), loadDetailRoute()]);
});

beforeEach(() => {
  // Default: admin signed in, tenant resolves. Both mocks resolve to
  // the same session object so per-test overrides of either function
  // remain ergonomic — tests typically only need to override the spec-
  // relevant one (e.g. R003 uses getCurrentSessionMock for the routes).
  const defaultSession = {
    user: {
      id: 'u-admin-1',
      email: 'admin@example.com',
      role: 'admin',
    },
  };
  getCurrentSessionMock.mockResolvedValue(defaultSession);
  requireSessionMock.mockResolvedValue(defaultSession);
  resolveTenantFromRequestMock.mockReturnValue({
    slug: TENANT_SLUG,
    tenantId: TENANT_SLUG,
  });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadListRoute() {
  try {
    // T060 routes now exist (Phase 4 GREEN 2b).
    return (await import('@/app/api/admin/events/route')) as {
      GET: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T053] admin events list route not yet implemented (T060). Import error: ${msg}`,
    );
  }
}

async function loadDetailRoute() {
  try {
    return (await import('@/app/api/admin/events/[eventId]/route')) as {
      GET: (
        req: NextRequest,
        ctx: { params: Promise<{ eventId: string }> },
      ) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T053] admin events detail route not yet implemented (T060). Import error: ${msg}`,
    );
  }
}

function buildListRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL('https://app.test/api/admin/events');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET' });
}

function buildDetailRequest(
  eventId: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): NextRequest {
  const url = new URL(`https://app.test/api/admin/events/${eventId}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET', headers });
}

// ---------------------------------------------------------------------------
// GET /api/admin/events — list contract
// ---------------------------------------------------------------------------

describe('T053 — GET /api/admin/events (list contract)', () => {
  it('200 OK — returns items[] + pagination + emptyStateContext envelope', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          {
            eventId: evtId('evt-1'),
            name: 'SweCham Midsummer 2026',
            startDate: '2026-06-21T18:00:00+07:00',
            category: 'networking',
            totalRegistrations: 47,
            matchedRegistrations: 44,
            matchRatePct: 93.6,
            isPartnerBenefit: true,
            isCulturalEvent: false,
            archivedAt: null,
            eventcreateUrl: 'https://events.swecham.com/midsummer-2026',
          },
        ],
        pagination: { page: 1, pageSize: 25, totalCount: 142 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 5,
        },
      },
    });

    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      eventId: 'evt-1',
      name: 'SweCham Midsummer 2026',
      matchRatePct: 93.6,
      isPartnerBenefit: true,
    });
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 25,
      totalCount: 142,
    });
    expect(body.emptyStateContext).toEqual({
      integrationConfigured: true,
      everReceivedDelivery: true,
      totalArchived: 5,
    });
  });

  it('200 OK — applies default pagination (page=1, pageSize=25) when params absent', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: false,
          everReceivedDelivery: false,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ page: 1, pageSize: 25 }),
    );
  });

  it('200 OK — honours page + pageSize + filter params', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 3, pageSize: 50, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    await GET(
      buildListRequest({
        page: '3',
        pageSize: '50',
        includeArchived: 'true',
        partnerBenefitOnly: 'true',
        culturalEventOnly: 'false',
        categoryFilter: 'networking',
      }),
    );
    expect(listEventsMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({
        page: 3,
        pageSize: 50,
        includeArchived: true,
        partnerBenefitOnly: true,
        culturalEventOnly: false,
        categoryFilter: 'networking',
      }),
    );
  });

  it('200 OK — clamps pageSize to bounds [10, 100] AND emits X-PageSize-Clamped header ', async () => {
    listEventsMock.mockResolvedValue({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 10, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: false,
          everReceivedDelivery: false,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();

    // Below-min: clamped to 10, header SET
    const resBelow = await GET(buildListRequest({ pageSize: '5' }));
    expect(listEventsMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 10 }),
    );
    expect(resBelow.headers.get('X-PageSize-Clamped')).toBe('true');

    // Above-max: clamped to 100, header SET
    const resAbove = await GET(buildListRequest({ pageSize: '500' }));
    expect(listEventsMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 100 }),
    );
    expect(resAbove.headers.get('X-PageSize-Clamped')).toBe('true');

    // In-range: header NOT emitted
    const resInRange = await GET(buildListRequest({ pageSize: '50' }));
    expect(listEventsMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 50 }),
    );
    expect(resInRange.headers.get('X-PageSize-Clamped')).toBeNull();
  });

  it('200 OK — emptyStateContext variant (a): no integration configured', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: false,
          everReceivedDelivery: false,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const body = await (await GET(buildListRequest())).json();
    expect(body.emptyStateContext.integrationConfigured).toBe(false);
  });

  it('200 OK — emptyStateContext variant (b): configured but no deliveries', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: false,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const body = await (await GET(buildListRequest())).json();
    expect(body.emptyStateContext.integrationConfigured).toBe(true);
    expect(body.emptyStateContext.everReceivedDelivery).toBe(false);
  });

  it('200 OK — emptyStateContext variant (c): all events archived', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 12,
        },
      },
    });
    const { GET } = await loadListRoute();
    const body = await (await GET(buildListRequest())).json();
    expect(body.emptyStateContext.totalArchived).toBe(12);
  });

  it('200 OK — manager role can read the list (FR-035 manager-read allowed)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: { id: 'u-mgr', email: 'mgr@example.com', role: 'manager' },
    });
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(200);
  });

  it('R6-W7 — unknown role string returns 404 (mutation-guard against role-gate inversion)', async () => {
    // R6-W7 staff-review fix (2026-05-13): an accidental inversion
    // of the role gate (`if (role === 'admin' || role === 'manager')`)
    // would still pass the admin/manager/member happy-path triad
    // because they cover the three KNOWN roles. An unexpected role
    // string distinguishes the additive-allow-list (correct) from a
    // subtractive-deny-list (incorrect). The role gate is structured
    // as deny-by-default; this test pins that semantics.
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-superadmin',
        email: 'superadmin@example.com',
        role: 'superadmin' as unknown as 'member',
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(404);
  });

  it('404 Not Found — member role returns 404 per FR-035 surface disclosure', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-mbr',
        email: 'member@example.com',
        role: 'member',
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(404);
    // Surface-disclosure: response body must NOT echo "forbidden" or
    // role identifier — must look like any other 404.
    const body = await res.text();
    expect(body.toLowerCase()).not.toMatch(/forbidden|role|admin/);
  });

  it('404 Not Found — member role emits role_violation_blocked audit ', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-mbr-audit',
        email: 'member@example.com',
        role: 'member',
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledTimes(1);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        actorType: 'member',
        tenantId: TENANT_SLUG,
        payload: expect.objectContaining({
          severity: 'warn',
          actorRole: 'member',
          attemptedRoute: '/api/admin/events',
          attemptedAction: 'list_events',
          blockedAt: 'app_layer',
        }),
      }),
    );
  });

  it('404 — audit emit failure does NOT block the 404 response (F1 fix observability-not-availability)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-mbr-audit-fail',
        email: 'member@example.com',
        role: 'member',
      },
    });
    emitStandaloneMock.mockRejectedValueOnce(new Error('DB unavailable'));
    // E4 fix: assert the failure was LOGGED
    // — the whole point of "observability is not an availability
    // dependency" is that the failure IS observable. A future refactor
    // that drops the catch-block log line would otherwise still pass
    // this test.
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(404);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_audit_emit_failed' }),
      expect.any(String),
    );
    loggerErrorSpy.mockRestore();
  });

  it('500 — use-case error propagates as 500', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', message: 'connection refused' },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(500);
  });

  // R003 staff-review fix (2026-05-13): route handlers switched from
  // `requireSession().catch(() => null)` to `getCurrentSession()` so
  // infra errors propagate as 500 instead of being silently masked as
  // 404. The original single T2 case asserted the OLD (swallow-all)
  // behaviour and is split into 2 cases below.
  // ---- T2a — getCurrentSession returns null (no session) → 404, no audit
  it('T2a — getCurrentSession null → 404, no audit emit', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  // ---- T2b — getCurrentSession throw (infra failure) → propagates
  it('T2b — getCurrentSession infra throw propagates (NOT silently 404)', async () => {
    getCurrentSessionMock.mockRejectedValueOnce(
      new Error('session_repo: connection refused'),
    );
    const { GET } = await loadListRoute();
    // R003 intent: infra errors must reach the framework's error
    // boundary (Next.js renders 500) rather than be coerced to 404.
    await expect(GET(buildListRequest())).rejects.toThrow(
      /connection refused/,
    );
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  // ---- T4 — invalid pagination params trigger 400 ------------------------
  it('T4 — page=0 → 400', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest({ page: '0' }));
    expect(res.status).toBe(400);
  });

  it('T4 — page=banana → 400 (zod NaN fails min(1))', async () => {
    // No mockResolvedValueOnce — schema validation fails before
    // listEventsMock is ever invoked. (Earlier draft queued one
    // here which leaked to the next test under the project's
    // vi.clearAllMocks convention; queued resolved values are
    // FIFO and not reset by clearAllMocks.)
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest({ page: 'banana' }));
    expect(res.status).toBe(400);
  });

  // ---- T10 — emptyStateContext always emitted even on populated list ----
  it('T10 — populated list still emits emptyStateContext', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          {
            eventId: evtId('evt-x'),
            name: 'foo',
            startDate: '2026-01-01T00:00:00Z',
            category: null,
            totalRegistrations: 1,
            matchedRegistrations: 1,
            matchRatePct: 100,
            isPartnerBenefit: false,
            isCulturalEvent: false,
            archivedAt: null,
            eventcreateUrl: null,
          },
        ],
        pagination: { page: 1, pageSize: 25, totalCount: 1 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const body = await (await GET(buildListRequest())).json();
    expect(body.emptyStateContext).toBeDefined();
    expect(body.emptyStateContext.integrationConfigured).toBe(true);
  });

  // ---- T8 — variant ambiguity: items=0 + delivered + zero archived -------
  it('T8 — items=0 + everReceivedDelivery=true + totalArchived=0 still returns full envelope', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [],
        pagination: { page: 1, pageSize: 25, totalCount: 0 },
        emptyStateContext: {
          integrationConfigured: true,
          everReceivedDelivery: true,
          totalArchived: 0,
        },
      },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.emptyStateContext.everReceivedDelivery).toBe(true);
    expect(body.emptyStateContext.totalArchived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/events/[eventId] — detail contract
// ---------------------------------------------------------------------------

describe('T053 — GET /api/admin/events/[eventId] (detail contract)', () => {
  function eventFixture() {
    return {
      eventId: evtId('evt-1'),
      name: 'SweCham Midsummer 2026',
      startDate: '2026-06-21T18:00:00+07:00',
      category: 'networking',
      totalRegistrations: 47,
      matchedRegistrations: 44,
      matchRatePct: 93.6,
      isPartnerBenefit: true,
      isCulturalEvent: false,
      archivedAt: null,
      eventcreateUrl: 'https://events.swecham.com/midsummer-2026',
      lastUpdatedAt: '2026-06-01T10:23:15Z',
    };
  }

  function registrationFixture() {
    return {
      registrationId: regId('reg-1'),
      attendeeEmail: attEmail('jane@fogmaker.com'),
      attendeeName: 'Jane Andersson',
      attendeeCompany: 'Fogmaker International AB',
      matchType: 'member_contact' as const,
      matchedMemberId: memId('mem-1'),
      matchedContactId: conId('ct-1'),
      ticketType: 'Member — Free',
      ticketPriceThb: 0,
      paymentStatus: 'paid' as const,
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: true,
      isOverQuota: false,
      registeredAt: '2026-06-01T10:23:15Z',
      // F6 Phase 9 / US6 — added to the DTO so the admin relink dialog
      // can render the FR-014 disallowed branch without a second
      // round-trip. Fixture defaults to false (non-pseudonymised row).
      isPseudonymised: false,
    };
  }

  it('200 OK — returns event + registrations[] + pagination envelope', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [registrationFixture()],
        pagination: { page: 1, pageSize: 50, totalCount: 47 },
      },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event.eventId).toBe('evt-1');
    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0].matchType).toBe('member_contact');
    expect(body.pagination.totalCount).toBe(47);
  });

  it('200 OK — applies default detail pagination (page=1, pageSize=50)', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();
    await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({
        eventId: 'evt-1',
        page: 1,
        pageSize: 50,
      }),
    );
  });

  it('200 OK — clamps detail pageSize to bounds [10, 200] AND emits X-PageSize-Clamped header ', async () => {
    loadEventDetailMock.mockResolvedValue({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 10, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();

    const resBelow = await GET(buildDetailRequest('evt-1', { pageSize: '5' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 10 }),
    );
    expect(resBelow.headers.get('X-PageSize-Clamped')).toBe('true');

    const resAbove = await GET(buildDetailRequest('evt-1', { pageSize: '5000' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 200 }),
    );
    expect(resAbove.headers.get('X-PageSize-Clamped')).toBe('true');

    const resInRange = await GET(buildDetailRequest('evt-1', { pageSize: '75' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenLastCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ pageSize: 75 }),
    );
    expect(resInRange.headers.get('X-PageSize-Clamped')).toBeNull();
  });

  it('200 OK — honours matchTypeFilter + unmatchedOnly + q params', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();
    await GET(
      buildDetailRequest('evt-1', {
        matchTypeFilter: 'member_fuzzy',
        unmatchedOnly: 'true',
        q: 'jane',
      }),
      { params: Promise.resolve({ eventId: 'evt-1' }) },
    );
    expect(loadEventDetailMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({
        matchTypeFilter: 'member_fuzzy',
        unmatchedOnly: true,
        q: 'jane',
      }),
    );
  });

  it('404 Not Found — event does not exist for this tenant (cross-tenant probe) + emits soft-probe warn log (L3 round-3)', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found' },
    });
    // L3 round-3 (2026-05-12): assert the soft cross-tenant probe
    // marker fires on every admin 404. Security forensics depends on
    // this log line being durably emitted — a regression that drops
    // it should fail the test.
    const loggerWarnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined as never);
    const { GET } = await loadDetailRoute();
    const eventId = 'a1b2c3d4-1234-4abc-89de-fedcba987654'; // valid UUID v4
    const res = await GET(buildDetailRequest(eventId), {
      params: Promise.resolve({ eventId }),
    });
    expect(res.status).toBe(404);
    // Surface-disclosure: response must not leak whether the row exists
    // in another tenant. A bare 404 is correct.
    const body = await res.text();
    expect(body).not.toMatch(/cross-tenant|other tenant/i);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'admin_event_detail_not_found',
        actor_user_id: 'u-admin-1',
        tenant_slug: TENANT_SLUG,
        event_id_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      }),
      expect.any(String),
    );
    loggerWarnSpy.mockRestore();
  });

  it('R8-I3 — cross_tenant_probe audit caps X-Request-ID at 200 chars (R7-G regression guard)', async () => {
    // R7-G applied .slice(0, 200) to the admin-side X-Request-ID
    // header before writing it to audit_log.payload.requestId. The
    // JSONB column has no size enforcement; without the cap an
    // authenticated admin could write unbounded text into the audit
    // row. This test pins the cap by asserting the emit-mock receives
    // a payload whose requestId length === 200 when given an
    // oversized header.
    loadEventDetailMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found' },
    });
    const { GET } = await loadDetailRoute();
    const eventId = 'a1b2c3d4-1234-4abc-89de-fedcba987654';
    const oversized = 'X'.repeat(500);
    await GET(
      buildDetailRequest(eventId, {}, { 'X-Request-ID': oversized }),
      { params: Promise.resolve({ eventId }) },
    );
    expect(emitStandaloneMock).toHaveBeenCalledTimes(1);
    const call = emitStandaloneMock.mock.calls[0] as [Record<string, unknown>];
    const entry = call[0] as {
      eventType: string;
      payload: { requestId: string | null };
    };
    expect(entry.eventType).toBe('cross_tenant_probe');
    expect(entry.payload.requestId).not.toBeNull();
    expect((entry.payload.requestId ?? '').length).toBe(200);
  });

  it('R8-I3 — cross_tenant_probe audit coerces empty/whitespace X-Request-ID to null', async () => {
    // Empty header (after trim) → null (distinguishes "no header"
    // from "real ID equal to ''"). The cap fix preserves this prior
    // semantic (length > 0 ? : null).
    loadEventDetailMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found' },
    });
    const { GET } = await loadDetailRoute();
    const eventId = 'a1b2c3d4-1234-4abc-89de-fedcba987654';
    await GET(
      buildDetailRequest(eventId, {}, { 'X-Request-ID': '   ' }),
      { params: Promise.resolve({ eventId }) },
    );
    expect(emitStandaloneMock).toHaveBeenCalledTimes(1);
    const call = emitStandaloneMock.mock.calls[0] as [Record<string, unknown>];
    const entry = call[0] as {
      eventType: string;
      payload: { requestId: string | null };
    };
    expect(entry.eventType).toBe('cross_tenant_probe');
    expect(entry.payload.requestId).toBeNull();
  });

  it('404 Not Found — member role returns 404 on detail per FR-035', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-mbr',
        email: 'member@example.com',
        role: 'member',
      },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(404);
  });

  it('404 — detail member-role emits role_violation_blocked audit ', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: {
        id: 'u-mbr-audit',
        email: 'member@example.com',
        role: 'member',
      },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-42'), {
      params: Promise.resolve({ eventId: 'evt-42' }),
    });
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledTimes(1);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        actorType: 'member',
        tenantId: TENANT_SLUG,
        payload: expect.objectContaining({
          severity: 'warn',
          actorRole: 'member',
          attemptedRoute: '/api/admin/events/evt-42',
          attemptedAction: 'load_event_detail',
          blockedAt: 'app_layer',
        }),
      }),
    );
  });

  it('200 OK — manager role can read detail (FR-035 manager-read allowed)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: { id: 'u-mgr', email: 'mgr@example.com', role: 'manager' },
    });
    loadEventDetailMock.mockResolvedValueOnce({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(200);
  });

  it('500 — detail use-case error propagates as 500', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', message: 'pg dead' },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(500);
  });

  // ---- T5 — invalid matchTypeFilter ---------
  it('T5 — matchTypeFilter=garbage → 400', async () => {
    const { GET } = await loadDetailRoute();
    const res = await GET(
      buildDetailRequest('evt-1', { matchTypeFilter: 'garbage' }),
      { params: Promise.resolve({ eventId: 'evt-1' }) },
    );
    expect(res.status).toBe(400);
  });

  // ---- T6 — empty-string vs whitespace q normalisation ------------------
  it('T6 — q="   " (whitespace) is normalised to null at route boundary', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();
    await GET(buildDetailRequest('evt-1', { q: '   ' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ q: null }),
    );
  });

  // ---- T7 — tenant-resolution failure surfaces as 500 -------------------
  it('T7 — resolveTenantFromRequest throw → 500 (logged + caught)', async () => {
    resolveTenantFromRequestMock.mockImplementationOnce(() => {
      throw new Error('unknown host');
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-1'), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// T3 — Kill-switch FEATURE_F6_EVENTCREATE=false
//
// Uses vi.resetModules() + vi.doMock to re-load the env module with
// f6EventCreate=false for these two tests only. The mock is reverted
// in afterEach via vi.doUnmock + vi.resetModules.
// ---------------------------------------------------------------------------

describe('T3 — kill-switch off → 404 + no audit', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });

  it('list route 404 when env.features.f6EventCreate=false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', async () => {
      // Preserve all other env fields (logger needs LOG_LEVEL, db needs
      // DATABASE_URL, etc.) — only override the F6 feature flag.
      const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
      return {
        ...actual,
        env: {
          ...actual.env,
          features: { ...actual.env.features, f6EventCreate: false },
        },
      };
    });
    // Re-register dependency mocks under the new module graph so the
    // route's imports (auth-session, tenant-context, events-admin-deps,
    // @/modules/events) still resolve to the test doubles.
    vi.doMock('@/lib/auth-session', () => ({
      getCurrentSession: () => getCurrentSessionMock(),
      requireSession: (...args: unknown[]) => requireSessionMock(...args),
    }));
    vi.doMock('@/lib/tenant-context', () => ({
      resolveTenantFromRequest: (...args: unknown[]) =>
        resolveTenantFromRequestMock(...args),
    }));
    vi.doMock('@/lib/events-admin-deps', () => ({
      runListEvents: (...args: Parameters<typeof runListEvents>) =>
        listEventsMock(...args),
      runLoadEventDetail: (...args: Parameters<typeof runLoadEventDetail>) =>
        loadEventDetailMock(...args),
    }));
    const { GET } = (await import('@/app/api/admin/events/route')) as {
      GET: (req: NextRequest) => Promise<Response>;
    };
    const url = new URL('https://app.test/api/admin/events');
    const res = await GET(new NextRequest(url.toString(), { method: 'GET' }));
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });

  it('detail route 404 when env.features.f6EventCreate=false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', async () => {
      // Preserve all other env fields (logger needs LOG_LEVEL, db needs
      // DATABASE_URL, etc.) — only override the F6 feature flag.
      const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
      return {
        ...actual,
        env: {
          ...actual.env,
          features: { ...actual.env.features, f6EventCreate: false },
        },
      };
    });
    vi.doMock('@/lib/auth-session', () => ({
      getCurrentSession: () => getCurrentSessionMock(),
      requireSession: (...args: unknown[]) => requireSessionMock(...args),
    }));
    vi.doMock('@/lib/tenant-context', () => ({
      resolveTenantFromRequest: (...args: unknown[]) =>
        resolveTenantFromRequestMock(...args),
    }));
    vi.doMock('@/lib/events-admin-deps', () => ({
      runListEvents: (...args: Parameters<typeof runListEvents>) =>
        listEventsMock(...args),
      runLoadEventDetail: (...args: Parameters<typeof runLoadEventDetail>) =>
        loadEventDetailMock(...args),
    }));
    const { GET } = (await import(
      '@/app/api/admin/events/[eventId]/route'
    )) as {
      GET: (
        req: NextRequest,
        ctx: { params: Promise<{ eventId: string }> },
      ) => Promise<Response>;
    };
    const url = new URL('https://app.test/api/admin/events/evt-1');
    const res = await GET(new NextRequest(url.toString(), { method: 'GET' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });
});
