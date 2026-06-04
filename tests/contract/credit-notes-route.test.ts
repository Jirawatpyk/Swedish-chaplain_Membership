/**
 * IM-2 (review follow-up) — Contract test: POST /api/credit-notes (US6).
 *
 * Covers the external HTTP boundary of the credit-note issue route:
 *   - 201 happy path
 *   - 400 invalid_json (malformed body)
 *   - 400 invalid_body (zod fail — missing required field)
 *   - 400 invalid_body — non-numeric creditTotalSatang string
 *   - 403 forbidden (manager role blocked)
 *   - 429 rate-limited (bucket exhausted)
 *   - 404 invoice_not_found → HTTP 404
 *   - 409 invalid_status → HTTP 409
 *   - 409 credit_exceeds_remainder → HTTP 409 with bigint→string payload
 *   - 422 settings_missing → HTTP 422 (aligned with issue-invoice)
 *   - 422 no_snapshot_on_invoice → HTTP 422
 *   - 422 overflow → HTTP 422
 *   - 500 pdf_render_failed → HTTP 500
 *   - 500 blob_upload_failed → HTTP 500
 *
 * Mocks `@/lib/admin-context`, the use-case, the rate limiter, and the
 * composition-root factory so the handler runs without touching the
 * real DB or session. Real-DB coverage for the happy path + invariants
 * lives in `tests/integration/invoicing/credit-note-partial-accumulation.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const issueCreditNoteMock = vi.fn();
const rateLimitCheckMock = vi.fn();
const makeIssueCreditNoteDepsMock: (...args: unknown[]) => unknown = vi.fn(
  () => ({}),
);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-cn-1',
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/modules/invoicing', async () => {
  const actual = await vi.importActual<typeof import('@/modules/invoicing')>(
    '@/modules/invoicing',
  );
  return {
    ...actual,
    issueCreditNote: (...args: unknown[]) => issueCreditNoteMock(...args),
    makeIssueCreditNoteDeps: (...args: unknown[]) =>
      makeIssueCreditNoteDepsMock(...args),
  };
});

const ADMIN_CONTEXT = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-cn-1',
};

const MANAGER_CONTEXT = {
  ...ADMIN_CONTEXT,
  current: { ...ADMIN_CONTEXT.current, user: { ...ADMIN_CONTEXT.current.user, role: 'manager' } },
};

function makeBody(overrides?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    invoiceId: '00000000-0000-0000-0000-000000000001',
    creditTotalSatang: '53500',
    reason: 'contract test',
    ...(overrides ?? {}),
  });
}

function makeReq(body: string | null = null): NextRequest {
  return new NextRequest('http://localhost/api/credit-notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ?? makeBody(),
  });
}

async function loadHandler() {
  const mod = await import('@/app/api/credit-notes/route');
  return mod.POST;
}

describe('POST /api/credit-notes — contract', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // First test in the file eats the cold-load cost of importing the
  // route handler (transitively pulls @react-pdf, Vercel Blob SDK,
  // Sarabun fonts, Upstash). On a dev laptop running the full
  // invoicing unit suite in parallel this can push past the 10s
  // default (see vitest.config.ts note). 30s is comfortable headroom.
  it('201 happy path — returns serialised credit note', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    issueCreditNoteMock.mockResolvedValueOnce(
      ok({
        tenantId: 'test',
        creditNoteId: 'cn-1',
        originalInvoiceId: '00000000-0000-0000-0000-000000000001',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: { raw: 'CN-2026-000001' },
        issueDate: '2026-04-20',
        issuedByUserId: 'admin-1',
        reason: 'contract test',
        creditAmount: { satang: 50000n },
        vat: { satang: 3500n },
        total: { satang: 53500n },
        tenantIdentitySnapshot: {},
        memberIdentitySnapshot: {},
        pdf: { blobKey: 'k', sha256: 'a'.repeat(64), templateVersion: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.credit_note_id).toBe('cn-1');
    expect(body.document_number).toBe('CN-2026-000001');
    // bigints serialise as strings.
    expect(body.total_satang).toBe('53500');
  }, 30_000);

  it('400 invalid_json on malformed body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    const POST = await loadHandler();
    const res = await POST(makeReq('not json at all'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_json');
  });

  it('400 invalid_body when reason missing (zod fail)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ invoiceId: '00000000-0000-0000-0000-000000000001', creditTotalSatang: '100' })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body on zero creditTotalSatang (S-3)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    const POST = await loadHandler();
    const res = await POST(makeReq(makeBody({ creditTotalSatang: '0' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    // A zero-value "credit note" is semantically meaningless — the
    // schema's positive-bigint refinement must reject it at the
    // boundary before the use-case ever runs.
    expect(issueCreditNoteMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body on non-numeric creditTotalSatang string', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    const POST = await loadHandler();
    const res = await POST(makeReq(makeBody({ creditTotalSatang: 'abc' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('403 forbidden when actor role is manager', async () => {
    requireAdminContextMock.mockResolvedValueOnce(MANAGER_CONTEXT);
    const POST = await loadHandler();
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    // Manager should never reach the rate limiter or the use-case.
    expect(rateLimitCheckMock).not.toHaveBeenCalled();
    expect(issueCreditNoteMock).not.toHaveBeenCalled();
  });

  it('429 rate-limited', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 10_000,
    });
    const POST = await loadHandler();
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect((await res.json()).error.code).toBe('rate_limited');
  });

  it.each([
    ['invoice_not_found', 404],
    ['invalid_status', 409],
    ['concurrent_state_change', 409],
    ['settings_missing', 422],
    ['no_snapshot_on_invoice', 422],
    // §86/10 ruling (final-review HIGH 1) — crediting a §105 receipt_separate
    // is a legally-invalid request → 422 Unprocessable Entity.
    ['receipt_not_creditable', 422],
    ['pdf_render_failed', 500],
    ['blob_upload_failed', 500],
  ] as const)('maps %s use-case error → HTTP %i', async (code, status) => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    issueCreditNoteMock.mockResolvedValueOnce(
      err(
        code === 'invalid_status'
          ? { code, status: 'draft' }
          : code === 'pdf_render_failed' || code === 'blob_upload_failed'
            ? { code, reason: 'test' }
            : { code },
      ),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    // pdf_render_failed / blob_upload_failed must NOT leak the raw
    // `reason` string (stripReason helper).
    if (code === 'pdf_render_failed' || code === 'blob_upload_failed') {
      expect(body.error.reason).toBeUndefined();
    }
  });

  it('409 credit_exceeds_remainder — bigint fields serialise to strings', async () => {
    requireAdminContextMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    issueCreditNoteMock.mockResolvedValueOnce(
      err({
        code: 'credit_exceeds_remainder',
        invoiceTotalSatang: 107000n,
        alreadyCreditedSatang: 53500n,
        proposedSatang: 64200n,
        remainingSatang: 53500n,
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('credit_exceeds_remainder');
    // JSON cannot carry bigint — every field serialises as a numeric string.
    expect(typeof body.error.invoiceTotalSatang).toBe('string');
    expect(body.error.invoiceTotalSatang).toBe('107000');
    expect(body.error.alreadyCreditedSatang).toBe('53500');
    expect(body.error.proposedSatang).toBe('64200');
    expect(body.error.remainingSatang).toBe('53500');
  });
});
