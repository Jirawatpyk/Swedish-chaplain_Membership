/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) — Contract test:
 * GET /api/invoices/member-renewal-context?memberId=<uuid>
 *
 * Client-side fetch driven by the New-invoice form's member picker
 * (`RenewalContextLoader` in `invoice-form.tsx`). Pins: 200 happy path
 * (wire shape uses snake_case per the route's own serialisation), 400 on
 * a missing/malformed memberId, 401/403 forwarded from
 * `requireAdminContext`, and 500 `lookup_failed` (non-throwing — the
 * client-side loader treats any non-2xx as "hide the panel") when the
 * `_lib` helper throws.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireAdminContextMock = vi.fn();
const loadMemberRenewalContextMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/app/(staff)/admin/invoices/_lib/member-renewal-context', () => ({
  loadMemberRenewalContext: (...args: unknown[]) => loadMemberRenewalContextMock(...args),
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-user-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin User',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-context-1',
};

const MEMBER_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeGetRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3100/api/invoices/member-renewal-context${query}`);
}

async function importRoute() {
  try {
    return await import('@/app/api/invoices/member-renewal-context/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[Task 9] route not yet implemented. Import error: ${msg}`);
  }
}

describe('contract: GET /api/invoices/member-renewal-context (Task 9)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 — happy path: snake_case wire shape mirrors the MemberRenewalContext', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'renewal' },
      periodTo: '2027-06-01',
      termMonths: 12,
      hasUnpaidMembershipInvoice: false,
    });

    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest(`?memberId=${MEMBER_ID}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      classification: { kind: 'renewal' },
      period_to: '2027-06-01',
      term_months: 12,
      has_unpaid_membership_invoice: false,
    });
    expect(loadMemberRenewalContextMock).toHaveBeenCalledWith('test-swecham', MEMBER_ID);
  });

  it('400 invalid_query — missing memberId', async () => {
    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest(''));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_query');
    expect(loadMemberRenewalContextMock).not.toHaveBeenCalled();
  });

  it('400 invalid_query — memberId is not a uuid', async () => {
    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest('?memberId=not-a-uuid'));
    expect(res.status).toBe(400);
    expect(loadMemberRenewalContextMock).not.toHaveBeenCalled();
  });

  it('403 forbidden — manager role rejected before reaching the lookup', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });
    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest(`?memberId=${MEMBER_ID}`));
    expect(res.status).toBe(403);
    expect(loadMemberRenewalContextMock).not.toHaveBeenCalled();
  });

  it('401 no-session — unauthenticated request forwarded from requireAdminContext', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), { status: 401 }),
    });
    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest(`?memberId=${MEMBER_ID}`));
    expect(res.status).toBe(401);
  });

  it('500 lookup_failed — the _lib helper throws (never crashes the route)', async () => {
    loadMemberRenewalContextMock.mockRejectedValueOnce(new Error('Neon blip'));
    const { GET } = (await importRoute()) as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(makeGetRequest(`?memberId=${MEMBER_ID}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('lookup_failed');
  });
});
