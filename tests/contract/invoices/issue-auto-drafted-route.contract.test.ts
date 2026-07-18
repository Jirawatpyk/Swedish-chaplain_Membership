/**
 * 107-auto-invoice Task 14 — Contract test:
 * POST /api/invoices/[invoiceId]/issue-auto-drafted.
 *
 * This route is the ONLY human-reachable path to `issueAutoDraftedRenewal`
 * (Task 9) — the generic `/issue` route refuses `origin='auto_renewal'`
 * drafts (Task 10). Every guard Task 9 built is reached through here or not
 * at all, so this contract pins:
 *
 *   - non-admin → 403 (before any use-case call)
 *   - `sendEmail` threads verbatim as a DEFINITE choice — `false` for
 *     "Issue silently" (never a fallback default), `true` for "Issue +
 *     Send" — proven by asserting the exact input the mocked use-case
 *     received, since `issueAutoDraftedRenewal`'s own live-Neon suite
 *     (Task 9) already proves the ZERO-vs-ONE outbox-row mechanics that
 *     flow FROM that boolean.
 *   - each typed `IssueAutoDraftError` kind maps to its documented HTTP
 *     status + a client body shape that carries exactly what Task 14's
 *     row-action component needs for refusal-reason parity with Task 13's
 *     queue badges (`invalid_draft.reason`, `duplicate_live_bill`'s
 *     `conflicting_invoice_id`) and nothing more (no `detail` leak).
 *   - `issue_failed` forwards its wrapped F4 `errorCode` through the SAME
 *     shared `issueErrorStatus` table the generic `/issue` route uses.
 *
 * Strategy mirrors `issue-route-auto-renewal-refusal.contract.test.ts`:
 * mock the infra seams + the renewals module's use-case/deps factory; the
 * route's own code runs unmodified.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueAutoDraftedRenewalMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-issue-auto-drafted-1',
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
    issueAutoDraftedRenewal: (...args: unknown[]) =>
      issueAutoDraftedRenewalMock(...args),
    makeIssueAutoDraftedRenewalDeps: () => ({}),
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
  requestId: 'req-issue-auto-drafted-1',
};

const DRAFT_ID = '550e8400-e29b-41d4-a716-446655440077';

const routeParams = { params: Promise.resolve({ invoiceId: DRAFT_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import(
    '@/app/api/invoices/[invoiceId]/issue-auto-drafted/route'
  )) as { POST: RoutePost };
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${DRAFT_ID}/issue-auto-drafted`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

const SUCCESS_VALUE = {
  invoiceId: DRAFT_ID,
  invoiceNumber: 'SC2026-00042',
  supersedeWarnings: [] as readonly string[],
  linkWarning: null,
  discardedInvoiceIds: [] as readonly string[],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/issue-auto-drafted (Task 14)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('403 for a non-admin caller — the use-case is never called', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(403);
    expect(issueAutoDraftedRenewalMock).not.toHaveBeenCalled();
  });

  it('Issue silently — sendEmail:false threads verbatim (never defaulted)', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(ok(SUCCESS_VALUE));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['invoice_number']).toBe('SC2026-00042');
    expect(issueAutoDraftedRenewalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: DRAFT_ID, sendEmail: false }),
    );
  });

  it('Issue + Send — sendEmail:true threads verbatim', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(ok(SUCCESS_VALUE));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: true }), routeParams);

    expect(res.status).toBe(200);
    expect(issueAutoDraftedRenewalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: DRAFT_ID, sendEmail: true }),
    );
  });

  it('400 invalid_body — sendEmail missing (no "no opinion" default; the route refuses to guess)', async () => {
    const { POST } = await importRoute();
    const res = await POST(makePostRequest({}), routeParams);

    expect(res.status).toBe(400);
    expect(issueAutoDraftedRenewalMock).not.toHaveBeenCalled();
  });

  it('surfaces supersedeWarnings + linkWarning + discardedInvoiceIds on success', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      ok({
        ...SUCCESS_VALUE,
        supersedeWarnings: ['superseded invoice SC2026-00040'],
        linkWarning: 'cycle could not be linked',
        discardedInvoiceIds: ['inv-sibling-1'],
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body['supersede_warnings']).toEqual(['superseded invoice SC2026-00040']);
    expect(body['link_warning']).toBe('cycle could not be linked');
    expect(body['discarded_invoice_ids']).toEqual(['inv-sibling-1']);
  });

  // -------------------------------------------------------------------------
  // Typed refusal → status + body mapping.
  // -------------------------------------------------------------------------

  it('409 duplicate_live_bill — carries conflicting_invoice_id + conflicting_status, no detail leak', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      err({
        kind: 'duplicate_live_bill',
        conflictingInvoiceId: 'inv-conflict-1',
        conflictingStatus: 'paid',
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({
      code: 'duplicate_live_bill',
      conflicting_invoice_id: 'inv-conflict-1',
      conflicting_status: 'paid',
    });
  });

  it('409 member_terminated — bare code, the free-text `reason` is withheld', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      err({ kind: 'member_terminated', reason: 'lapsed past grace period' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'member_terminated' });
  });

  it('422 invalid_draft{plan_year_drift} — forwards the closed reason enum (Task 13 parity), withholds detail', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      err({
        kind: 'invalid_draft',
        reason: 'plan_year_drift',
        detail: 'invoice plan_year 2025 != cycle-derived fiscal year 2026',
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'invalid_draft', reason: 'plan_year_drift' });
  });

  it('404 draft_not_found', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(err({ kind: 'draft_not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'draft_not_found' });
  });

  it('404 cycle_not_found', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(404);
  });

  it('422 issue_failed{overflow} — forwards through the shared issueErrorStatus table, withholds detail', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      err({ kind: 'issue_failed', errorCode: 'overflow', detail: '§87 sequence exhausted' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'issue_failed', error_code: 'overflow' });
  });

  it('500 issue_failed{pdf_render_failed} — logged at ERROR (server fault), not WARN', async () => {
    issueAutoDraftedRenewalMock.mockResolvedValueOnce(
      err({ kind: 'issue_failed', errorCode: 'pdf_render_failed', detail: 'font missing' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(500);
    const loggerMock = await import('@/lib/logger');
    expect(loggerMock.logger.error).toHaveBeenCalled();
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
  });

  it('429 rate-limited before the use-case runs', async () => {
    const authDeps = await import('@/lib/auth-deps');
    (authDeps.rateLimiter.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
    });

    const { POST } = await importRoute();
    const res = await POST(makePostRequest({ sendEmail: false }), routeParams);

    expect(res.status).toBe(429);
    expect(issueAutoDraftedRenewalMock).not.toHaveBeenCalled();
  });
});
