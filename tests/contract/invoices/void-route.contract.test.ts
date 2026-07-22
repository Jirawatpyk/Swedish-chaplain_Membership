/**
 * Contract test: POST /api/invoices/[invoiceId]/void
 *
 * Pins the HTTP-boundary behaviour of the void route, with emphasis on the two
 * guarantees the 2026-07-18 audit-fix added and which had NO route-level
 * coverage before:
 *
 *   - CWE-915 mass-assignment: server-derived identity (tenantId, actorUserId,
 *     requestId) and the internal void-on-reissue flags (requireStatus,
 *     suppressCancellationEmail, supersededByInvoiceId) can NEVER be set from
 *     the request body. Without this test a revert to spreading the body over
 *     the server fields — or to parsing the wide use-case schema — would ship
 *     silently.
 *   - a malformed `invoiceId` path param returns a clean 400 rather than
 *     reaching the DB and raising Postgres 22P02 → an opaque 500.
 *
 * Strategy mirrors event-draft.contract.test.ts: mock the infrastructure seams
 * and the use-case, but keep the REAL invoicing barrel (so the route's own
 * schema parse + parseInvoiceId guard run unmodified). voidInvoice is mocked to
 * return `err` so the assertions read its CALL ARGUMENTS — the mass-assignment
 * property is about what the route PASSES to the use-case, independent of the
 * response.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const voidInvoiceMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-void-1',
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// F8 flag OFF — the Step-2.4 cycle-unlink seam is only wired when
// FEATURE_F8_RENEWALS is on, and this suite pins the HTTP boundary only. Keep
// the route off the @/modules/renewals dynamic import (pay-route-guard parity).
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f8Renewals: false },
    },
  };
});

vi.mock('@/modules/invoicing', async (importOriginal) => {
  // Keep the real schema + parseInvoiceId so the route's validation boundary is
  // exercised for real; override only the use-case + deps factory.
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    voidInvoice: (...args: unknown[]) => voidInvoiceMock(...args),
    makeVoidInvoiceDeps: () => ({}),
  };
});

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
  requestId: 'req-void-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000';

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3100/api/invoices/x/void', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callRoute(invoiceId: string, body: unknown): Promise<Response> {
  const { POST } = (await import('@/app/api/invoices/[invoiceId]/void/route')) as {
    POST: (req: NextRequest, ctx: { params: Promise<{ invoiceId: string }> }) => Promise<Response>;
  };
  return POST(makePostRequest(body), { params: Promise.resolve({ invoiceId }) });
}

describe('contract: POST /api/invoices/[invoiceId]/void', () => {
  // Warm the route import once — it transitively pulls @react-pdf + Blob + fonts,
  // whose cold-load can exceed a per-test budget under the parallel suite and
  // strand an unconsumed mock. Mirrors event-draft.contract.test.ts.
  beforeAll(async () => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    voidInvoiceMock.mockResolvedValue(err({ code: 'invoice_not_found' }));
    await import('@/app/api/invoices/[invoiceId]/void/route').catch(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    requireAdminContextMock.mockResolvedValue(adminContext);
    voidInvoiceMock.mockResolvedValue(err({ code: 'invoice_not_found' }));
  });

  it('threads server-derived identity + voidReason to the use-case', async () => {
    await callRoute(VALID_INVOICE_ID, { voidReason: 'duplicate of SC-2026-000123' });

    expect(voidInvoiceMock).toHaveBeenCalledTimes(1);
    const input = voidInvoiceMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.tenantId).toBe('test-swecham');
    expect(input.actorUserId).toBe('admin-user-1');
    expect(input.requestId).toBe('req-void-1');
    expect(input.invoiceId).toBe(VALID_INVOICE_ID);
    expect(input.voidReason).toBe('duplicate of SC-2026-000123');
  });

  it('ignores client-supplied tenantId / actorUserId / requestId in the body (CWE-915)', async () => {
    await callRoute(VALID_INVOICE_ID, {
      voidReason: 'legit reason',
      tenantId: 'attacker-tenant',
      actorUserId: 'victim-user-99',
      requestId: 'forged-request-id',
    });

    expect(voidInvoiceMock).toHaveBeenCalledTimes(1);
    const input = voidInvoiceMock.mock.calls[0]![1] as Record<string, unknown>;
    // Server values win — the body's hostile values never reach the use-case.
    expect(input.tenantId).toBe('test-swecham');
    expect(input.actorUserId).toBe('admin-user-1');
    expect(input.requestId).toBe('req-void-1');
  });

  it('drops the internal void-on-reissue flags when sent from the body (CWE-915)', async () => {
    await callRoute(VALID_INVOICE_ID, {
      voidReason: 'legit reason',
      requireStatus: 'issued',
      suppressCancellationEmail: true,
      supersededByInvoiceId: '11111111-1111-1111-1111-111111111111',
    });

    expect(voidInvoiceMock).toHaveBeenCalledTimes(1);
    const input = voidInvoiceMock.mock.calls[0]![1] as Record<string, unknown>;
    // The HTTP-boundary schema only carries voidReason; the internal flags a
    // client tried to set must not appear on the use-case input.
    expect(input).not.toHaveProperty('requireStatus');
    expect(input).not.toHaveProperty('suppressCancellationEmail');
    expect(input).not.toHaveProperty('supersededByInvoiceId');
  });

  it('returns 400 for a malformed invoiceId path param without touching the use-case', async () => {
    const res = await callRoute('not-a-uuid', { voidReason: 'legit reason' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { fieldErrors: Record<string, string[]> } };
    };
    expect(body.error.code).toBe('invalid_body');
    // Same `.flatten()` shape as the body-validation 400, so a client reads a
    // field error the same way whichever input failed.
    expect(body.error.details.fieldErrors.invoiceId).toEqual(['invalid_invoice_id']);
    // The guard short-circuits before the use-case — no DB round-trip, no 22P02.
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('returns 400 when voidReason is missing', async () => {
    const res = await callRoute(VALID_INVOICE_ID, {});

    expect(res.status).toBe(400);
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin (manager) actor', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      ...adminContext,
      current: { ...adminContext.current, user: { ...adminContext.current.user, role: 'manager' } },
    });

    const res = await callRoute(VALID_INVOICE_ID, { voidReason: 'legit reason' });

    expect(res.status).toBe(403);
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });
});
