/**
 * 065 review follow-up [Sev 5, item 4] — Contract test:
 * POST /api/invoices/[invoiceId]/pay — 064 legacy no-TIN event guard.
 *
 * FIRST-EVER contract harness for the /pay route. Scope is deliberately
 * minimal (mirrors issue-route-guard.contract.test.ts): the 064 interim
 * guard's route arm — `recordPayment` returns
 * `legacy_no_tin_event_needs_remediation` and the route MUST map it to 409
 * with the bare code (site 3/15 of the REMOVE-WITH-064-REMEDIATION master
 * checklist at the guard in record-payment.ts). Without this pin, the
 * 409-map line could be dropped and the inline ternary's `: 422` tail would
 * silently misclassify the conflict — with the admin toast branch keyed on
 * the code still compiled and every unit test green.
 *
 * REMOVE-WITH-064-REMEDIATION (site 14 — delete this file when the interim
 * guard is removed; see docs/runbooks/event-invoice-legacy-no-tin-remediation.md).
 *
 * Strategy mirrors the sibling issue-route harnesses: mock infra seams + the
 * invoicing module's use-case/deps factory; the route's own code runs
 * unmodified (the REAL recordPaymentSchema validates the body).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const recordPaymentMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-pay-guard-1',
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// F8 flag OFF — the route must not touch @/modules/renewals in this suite
// (issue-as-paid harness parity). Keep the REAL env otherwise.
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
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    recordPayment: (...args: unknown[]) => recordPaymentMock(...args),
    makeRecordPaymentDeps: () => ({}),
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
  requestId: 'req-pay-guard-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440066';

const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import('@/app/api/invoices/[invoiceId]/pay/route')) as {
    POST: RoutePost;
  };
}

function makePostRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/pay`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Schema-valid body — the guard fires inside the use-case, not at parse.
      body: JSON.stringify({ paymentMethod: 'bank_transfer', paymentDate: '2026-01-15' }),
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/pay — legacy no-TIN event guard (065 item 4)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('409 legacy_no_tin_event_needs_remediation — bare code, no detail leak', async () => {
    recordPaymentMock.mockResolvedValueOnce(
      err({ code: 'legacy_no_tin_event_needs_remediation' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    // Exactly the typed code — no reason / message / remediation detail.
    expect(body.error).toEqual({ code: 'legacy_no_tin_event_needs_remediation' });
  });

  it('409 membership_terminated — bare code (066 §4.4(1) gate → route 409 map)', async () => {
    // Pins the branch's new `: result.error.code === 'membership_terminated'
    // ? 409` arm. Without this, that arm could be dropped and the ternary's
    // `: 422` tail would silently misclassify a terminated-member refusal —
    // every unit test still green (same latent class the legacy_no_tin pin
    // above guards).
    recordPaymentMock.mockResolvedValueOnce(err({ code: 'membership_terminated' }));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(), routeParams);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'membership_terminated' });
  });

  it('SECURITY (066 §4.4(1)): client-supplied triggeredBy/tenantId/actorUserId are overridden server-side — the terminated gate cannot be bypassed', async () => {
    // CWE-915 regression guard: a client sending `triggeredBy:'webhook'`
    // (the ONE trigger the gate exempts) must NOT reach the use-case — the
    // route hard-pins it to 'admin_manual'. Same for the RLS/audit fields.
    recordPaymentMock.mockResolvedValueOnce(err({ code: 'settings_missing' }));

    const { POST } = await importRoute();
    const malicious = new NextRequest(
      `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/pay`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-01-15',
          triggeredBy: 'webhook', // ← attempt to skip the gate
          tenantId: 'evil-tenant', // ← attempt to cross tenants
          actorUserId: 'evil-actor', // ← attempt to spoof the audit actor
        }),
      },
    );
    await POST(malicious, routeParams);

    // The route passes (deps, input) to recordPayment; assert the SERVER
    // values won, not the client's.
    const passedInput = recordPaymentMock.mock.calls[0]![1] as {
      triggeredBy?: string;
      tenantId: string;
      actorUserId: string;
    };
    expect(passedInput.triggeredBy).toBe('admin_manual');
    expect(passedInput.tenantId).toBe('test-swecham');
    expect(passedInput.actorUserId).toBe('admin-user-1');
  });
});
