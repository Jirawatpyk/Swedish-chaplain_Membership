/**
 * 107-auto-invoice Task 14 — Contract test:
 * POST /api/invoices/[invoiceId]/discard-auto-draft.
 *
 * Strategy mirrors `issue-auto-drafted-route.contract.test.ts`: mock the
 * infra seams + the renewals module's use-case/deps factory; the route's
 * own code runs unmodified.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireApiPermissionMock = vi.fn();
const discardAutoDraftedRenewalMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-discard-auto-draft-1',
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({
      success: true,
      reset: Date.now() + 60_000,
    })),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/modules/renewals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/renewals')>();
  return {
    ...actual,
    discardAutoDraftedRenewal: (...args: unknown[]) =>
      discardAutoDraftedRenewalMock(...args),
    makeDiscardAutoDraftedRenewalDeps: () => ({}),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  requestId: 'req-discard-auto-draft-1',
};

const DRAFT_ID = '550e8400-e29b-41d4-a716-446655440088';

const routeParams = { params: Promise.resolve({ invoiceId: DRAFT_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import(
    '@/app/api/invoices/[invoiceId]/discard-auto-draft/route'
  )) as { POST: RoutePost };
}

function makePostRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${DRAFT_ID}/discard-auto-draft`,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/discard-auto-draft (Task 14)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('403 for a non-admin caller — the use-case is never called', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(403);
    expect(discardAutoDraftedRenewalMock).not.toHaveBeenCalled();
  });

  it('200 — draft discarded, audit_emitted echoed from the use-case', async () => {
    discardAutoDraftedRenewalMock.mockResolvedValueOnce(
      ok({ invoiceId: DRAFT_ID, auditEmitted: true }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ invoice_id: DRAFT_ID, audit_emitted: true });
    expect(discardAutoDraftedRenewalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        invoiceId: DRAFT_ID,
        actorUserId: 'admin-user-1',
        tenantId: 'test-swecham',
      }),
    );
  });

  it('409 not_draft — a concurrent Issue action promoted the row first', async () => {
    discardAutoDraftedRenewalMock.mockResolvedValueOnce(err({ kind: 'not_draft' }));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'not_draft' });
  });

  it('404 not_found', async () => {
    discardAutoDraftedRenewalMock.mockResolvedValueOnce(err({ kind: 'not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'not_found' });
  });

  it('429 rate-limited before the use-case runs', async () => {
    const authDeps = await import('@/lib/auth-deps');
    (authDeps.rateLimiter.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
    });

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(429);
    expect(discardAutoDraftedRenewalMock).not.toHaveBeenCalled();
  });

  // Review round 1 MINOR — same 60/5min bucket + rationale as the sibling
  // `/issue-auto-drafted` route (batch-clearing is routine on the discard
  // side too).
  it('rate-limit bucket is 60 per (tenant, actor) per 5 minutes', async () => {
    const authDeps = await import('@/lib/auth-deps');
    discardAutoDraftedRenewalMock.mockResolvedValueOnce(
      ok({ invoiceId: DRAFT_ID, auditEmitted: true }),
    );

    const { POST } = await importRoute();
    await POST(makePostRequest(), routeParams);

    expect(authDeps.rateLimiter.check).toHaveBeenCalledWith(
      `f4:discard-auto-draft:test-swecham:admin-user-1`,
      60,
      300,
    );
  });
});
