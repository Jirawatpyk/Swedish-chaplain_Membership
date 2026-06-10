/**
 * Task 11 (064-event-invoice-paid-flow) — Contract test:
 * POST /api/invoices/[invoiceId]/issue — §105 no-TIN event guard.
 *
 * FIRST-EVER contract test for the /issue route. Scope is deliberately
 * limited to the NEW guard added by 064 Task 7: an EVENT draft whose buyer
 * has no TIN must NOT be billable first (its only legal document is a §105
 * receipt minted at payment time via /issue-as-paid). The use-case returns
 * `event_no_tin_requires_paid_issue`; the route must map it to 422 with the
 * bare code and nothing else (no reason / message passthrough).
 *
 * Strategy mirrors issue-as-paid.contract.test.ts: mock infra seams + the
 * invoicing module's use-case/deps factory; the route's own code runs
 * unmodified.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueInvoiceMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-issue-guard-1',
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

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    issueInvoice: (...args: unknown[]) => issueInvoiceMock(...args),
    makeIssueInvoiceDeps: () => ({}),
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
  requestId: 'req-issue-guard-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440065';

const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import('@/app/api/invoices/[invoiceId]/issue/route')) as {
    POST: RoutePost;
  };
}

function makePostRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/issue`,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/issue — no-TIN event guard (Task 11)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('422 event_no_tin_requires_paid_issue — bare code, no detail leak', async () => {
    issueInvoiceMock.mockResolvedValueOnce(
      err({ code: 'event_no_tin_requires_paid_issue' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('event_no_tin_requires_paid_issue');
    // Exactly the typed code — no reason / message / stack fragments.
    expect(Object.keys(body.error)).toEqual(['code']);
  });

  it('guard failure is logged with errorCode only (no PII fields)', async () => {
    issueInvoiceMock.mockResolvedValueOnce(
      err({ code: 'event_no_tin_requires_paid_issue' }),
    );

    const { POST } = await importRoute();
    await POST(makePostRequest(), routeParams);

    const loggerMock = await import('@/lib/logger');
    const warnCalls = (loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const failureCall = warnCalls.find(
      (c) => typeof c[1] === 'string' && (c[1] as string).includes('failed'),
    );
    expect(failureCall).toBeDefined();
    const fields = failureCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      requestId: 'req-issue-guard-1',
      tenantId: 'test-swecham',
      invoiceId: VALID_INVOICE_ID,
      errorCode: 'event_no_tin_requires_paid_issue',
    });
  });
});
