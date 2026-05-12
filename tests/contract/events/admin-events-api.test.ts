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
 *   • FR-035 surface-disclosure: member role → 404 (not 403)
 *   • 404 for missing event id OR cross-tenant id (use-case returns null
 *     ⇒ route maps to 404 with no event-id echo)
 *
 * Pattern mirrors tests/contract/events/webhook-eventcreate-v1.test.ts —
 * module-boundary mocks for `@/modules/events` use-cases so no DB, no
 * tenant resolution, no auth infrastructure is hit. Each test stubs the
 * use-case return value.
 *
 * RED reason: route handlers (T060), use-cases (T057+T058) and the
 * admin-deps composition adapter (`@/lib/events-admin-deps`) do not exist
 * yet. The dynamic `import()` throws MODULE_NOT_FOUND making every test
 * FAIL with a clear marker.
 *
 * Turns GREEN: T057 list-events + T058 load-event-detail + T060 routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams — replace heavy dependencies at module boundary.
// ---------------------------------------------------------------------------

const listEventsMock = vi.fn();
const loadEventDetailMock = vi.fn();
const requireSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>(
    '@/modules/events',
  );
  return {
    ...actual,
    listEvents: (...args: unknown[]) => listEventsMock(...args),
    loadEventDetail: (...args: unknown[]) => loadEventDetailMock(...args),
  };
});

// Mock the composition adapter (route handler's only DB seam) so no
// Drizzle pool / Neon connection is required. The `run*` wrappers stub
// `runInTenant(...)` + use-case dispatch in one call — the test
// controls the result by injecting fake Result objects via the
// `listEventsMock` / `loadEventDetailMock` factories so we can also
// observe the input arguments (the route's parsed params).
vi.mock('@/lib/events-admin-deps', () => ({
  runListEvents: (_tenantSlug: string, input: unknown) =>
    listEventsMock(_tenantSlug, input),
  runLoadEventDetail: (_tenantSlug: string, input: unknown) =>
    loadEventDetailMock(_tenantSlug, input),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: (...args: unknown[]) => requireSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

const TENANT_SLUG = 'test-swecham';

beforeEach(() => {
  // Default: admin signed in, tenant resolves.
  requireSessionMock.mockResolvedValue({
    user: {
      userId: 'u-admin-1',
      email: 'admin@example.com',
      role: 'admin',
    },
  });
  resolveTenantFromRequestMock.mockReturnValue({
    slug: TENANT_SLUG,
    tenantId: TENANT_SLUG,
  });
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
): NextRequest {
  const url = new URL(`https://app.test/api/admin/events/${eventId}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET' });
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
            eventId: 'evt-1',
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
      expect.anything(),
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
      expect.anything(),
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

  it('200 OK — clamps pageSize to bounds [10, 100]', async () => {
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

    await GET(buildListRequest({ pageSize: '5' }));
    expect(listEventsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ pageSize: 10 }),
    );

    await GET(buildListRequest({ pageSize: '500' }));
    expect(listEventsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ pageSize: 100 }),
    );
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
    requireSessionMock.mockResolvedValueOnce({
      user: { userId: 'u-mgr', email: 'mgr@example.com', role: 'manager' },
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

  it('404 Not Found — member role returns 404 per FR-035 surface disclosure', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: {
        userId: 'u-mbr',
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

  it('500 — use-case error propagates as 500', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', message: 'connection refused' },
    });
    const { GET } = await loadListRoute();
    const res = await GET(buildListRequest());
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/events/[eventId] — detail contract
// ---------------------------------------------------------------------------

describe('T053 — GET /api/admin/events/[eventId] (detail contract)', () => {
  function eventFixture() {
    return {
      eventId: 'evt-1',
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
    };
  }

  function registrationFixture() {
    return {
      registrationId: 'reg-1',
      attendeeEmail: 'jane@fogmaker.com',
      attendeeName: 'Jane Andersson',
      attendeeCompany: 'Fogmaker International AB',
      matchType: 'member_contact',
      matchedMemberId: 'mem-1',
      matchedContactId: 'ct-1',
      ticketType: 'Member — Free',
      ticketPriceThb: 0,
      paymentStatus: 'paid',
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: true,
      isOverQuota: false,
      registeredAt: '2026-06-01T10:23:15Z',
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
      expect.anything(),
      expect.objectContaining({
        eventId: 'evt-1',
        page: 1,
        pageSize: 50,
      }),
    );
  });

  it('200 OK — clamps detail pageSize to bounds [10, 200]', async () => {
    loadEventDetailMock.mockResolvedValue({
      ok: true,
      value: {
        event: eventFixture(),
        registrations: [],
        pagination: { page: 1, pageSize: 10, totalCount: 0 },
      },
    });
    const { GET } = await loadDetailRoute();

    await GET(buildDetailRequest('evt-1', { pageSize: '5' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ pageSize: 10 }),
    );

    await GET(buildDetailRequest('evt-1', { pageSize: '5000' }), {
      params: Promise.resolve({ eventId: 'evt-1' }),
    });
    expect(loadEventDetailMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ pageSize: 200 }),
    );
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
      expect.anything(),
      expect.objectContaining({
        matchTypeFilter: 'member_fuzzy',
        unmatchedOnly: true,
        q: 'jane',
      }),
    );
  });

  it('404 Not Found — event does not exist for this tenant (cross-tenant probe)', async () => {
    loadEventDetailMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found' },
    });
    const { GET } = await loadDetailRoute();
    const res = await GET(buildDetailRequest('evt-not-mine'), {
      params: Promise.resolve({ eventId: 'evt-not-mine' }),
    });
    expect(res.status).toBe(404);
    // Surface-disclosure: response must not leak whether the row exists
    // in another tenant. A bare 404 is correct.
    const body = await res.text();
    expect(body).not.toMatch(/cross-tenant|other tenant/i);
  });

  it('404 Not Found — member role returns 404 on detail per FR-035', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: {
        userId: 'u-mbr',
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

  it('200 OK — manager role can read detail (FR-035 manager-read allowed)', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: { userId: 'u-mgr', email: 'mgr@example.com', role: 'manager' },
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
});
