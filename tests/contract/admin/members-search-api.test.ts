/**
 * Round-1 test-M5 closure — contract test for
 * `GET /api/admin/members/search?q=&limit=`.
 *
 * New endpoint shipped in F6 Phase 9 to back the relink dialog's
 * member picker. Covers:
 *   - 200 OK happy-path with non-empty results (admin)
 *   - 200 OK with `primaryContact=null` mapping to `primaryContactName: null`
 *     (not "undefined undefined")
 *   - 400 invalid query (empty `q`, oversized `limit`)
 *   - 401/403 path via `requireAdminContext` (member role denied)
 *   - 500 when use-case returns server_error
 *
 * Mock surface: directorySearch use-case + admin context + tenant.
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

const directorySearchMock = vi.fn();
const requireAdminContextMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();

vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    directorySearch: (...args: unknown[]) => directorySearchMock(...args),
  };
});

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (tenant: unknown) => ({
    tenant,
    memberRepo: {} as unknown,
  }),
}));

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

const TENANT_SLUG = 'test-swecham';
const ADMIN_CONTEXT = {
  requestId: 'req-admin-1',
  current: {
    user: { id: 'admin-1', role: 'admin' as const, email: 'a@t' },
  },
};

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  requireAdminContextMock.mockResolvedValue(ADMIN_CONTEXT);
  directorySearchMock.mockResolvedValue({
    ok: true,
    value: {
      items: [
        {
          member: { memberId: 'm-1', companyName: 'Acme Co Ltd' },
          primaryContact: { firstName: 'Jane', lastName: 'Doe' },
        },
      ],
      nextCursor: null,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return (await import('@/app/api/admin/members/search/route')) as {
    GET: (req: NextRequest) => Promise<Response>;
  };
}

function buildRequest(query: string): NextRequest {
  return new NextRequest(`http://test/api/admin/members/search?${query}`, {
    method: 'GET',
  });
}

describe('GET /api/admin/members/search (Round-1 test-M5)', () => {
  it('200 OK — returns mapped items with companyName + primaryContactName', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q=acme&limit=10'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: ReadonlyArray<{
        memberId: string;
        companyName: string;
        primaryContactName: string | null;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.memberId).toBe('m-1');
    expect(body.items[0]?.companyName).toBe('Acme Co Ltd');
    expect(body.items[0]?.primaryContactName).toBe('Jane Doe');
    // Round-2 test-M5 closure — assert use-case was called with the
    // parsed query + limit shape so a regression that drops a field
    // or swaps in a different use-case surfaces here.
    expect(directorySearchMock).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ q: 'acme', limit: 10 }),
    );
  });

  it('200 OK — primaryContact=null surfaces as primaryContactName=null (not "undefined undefined")', async () => {
    directorySearchMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          {
            member: { memberId: 'm-noctc', companyName: 'No-Contact Co' },
            primaryContact: null,
          },
        ],
        nextCursor: null,
      },
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q=no'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: ReadonlyArray<{ primaryContactName: string | null }>;
    };
    expect(body.items[0]?.primaryContactName).toBeNull();
  });

  it('400 — empty q rejected by zod', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q='));
    expect(res.status).toBe(400);
    expect(directorySearchMock).not.toHaveBeenCalled();
  });

  it('400 — limit > 50 rejected', async () => {
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q=acme&limit=51'));
    expect(res.status).toBe(400);
    expect(directorySearchMock).not.toHaveBeenCalled();
  });

  it('admin-context denial bubbles up (e.g. member role)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(null, { status: 404 }),
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q=acme'));
    expect(res.status).toBe(404);
    expect(directorySearchMock).not.toHaveBeenCalled();
  });

  it('500 — use-case server_error mapped to 500', async () => {
    directorySearchMock.mockResolvedValueOnce({
      ok: false,
      error: { type: 'server_error', message: 'simulated' },
    });
    const { GET } = await loadRoute();
    const res = await GET(buildRequest('q=acme'));
    expect(res.status).toBe(500);
  });
});
