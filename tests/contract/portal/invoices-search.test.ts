/**
 * T086 — Contract test: GET /api/portal/invoices/search (F5 Group I).
 *
 * Covers:
 *   - 401 when no session (non-member caller is 403 via member-context).
 *   - 200 happy path returns `{invoices: [{id, invoiceNumber, amountDue, currency}]}`.
 *   - Use-case receives `status: 'issued'` so paid/void/credited are filtered server-side.
 *   - 429 when rate-limited.
 *   - 500 on repo error.
 *
 * Mocks member-context + rateLimiter + listInvoicesByMember so no DB
 * or session machinery is exercised.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const listInvoicesByMemberMock = vi.fn();
const rateLimiterCheckMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeListInvoicesByMemberDepsMock = vi.fn((..._args: unknown[]) => ({}));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) =>
    requireMemberContextMock(...args),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: (...args: unknown[]) => rateLimiterCheckMock(...args),
  },
}));
vi.mock('@/modules/invoicing', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/invoicing')>(
      '@/modules/invoicing',
    );
  return {
    ...actual,
    listInvoicesByMember: (...args: unknown[]) =>
      listInvoicesByMemberMock(...args),
    makeListInvoicesByMemberDeps: (...args: unknown[]) =>
      makeListInvoicesByMemberDepsMock(...args),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const memberContext = {
  current: { user: { id: 'user-1', role: 'member' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: 'mem-1' },
  memberId: 'mem-1',
  ownContact: { contactId: 'con-1' },
  ownContactId: 'con-1',
  sourceIp: '127.0.0.1',
  requestId: 'req-1',
};

function makeRequest(q: string = ''): NextRequest {
  const url = q
    ? `http://localhost/api/portal/invoices/search?q=${encodeURIComponent(q)}`
    : 'http://localhost/api/portal/invoices/search';
  return new NextRequest(url, { method: 'GET' });
}

describe('contract: GET /api/portal/invoices/search (T086)', () => {
  afterEach(() => vi.clearAllMocks());

  it('401 when member-context returns a rejection (no session)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('403 when caller is not a member (member-context rejects staff)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest('TSCC'));
    expect(res.status).toBe(403);
  });

  it('200 returns the expected shape (major-unit THB) and passes status:"issued" to the use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });
    listInvoicesByMemberMock.mockResolvedValueOnce(
      ok({
        rows: [
          {
            invoiceId: 'inv-1',
            documentNumber: { toString: () => 'TSCC-2026-0007' },
            total: { satang: 5_350_000n },
            currency: 'THB',
          },
        ],
        total: 1,
      }),
    );

    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest('TSCC'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invoices: Array<{
        id: string;
        invoiceNumber: string;
        amountDue: number;
        currency: string;
      }>;
    };
    // F-01 fix: amount is major-unit THB (53,500) not minor-unit
    // satang (5_350_000). Members type "53500" into the palette, so
    // the fuzzy-value string MUST carry the same unit.
    expect(body.invoices).toEqual([
      {
        id: 'inv-1',
        invoiceNumber: 'TSCC-2026-0007',
        amountDue: 53_500,
        currency: 'THB',
      },
    ]);

    // Use-case must receive status: 'issued' — enforces the spec rule
    // that paid/void/credited invoices are filtered server-side.
    const call = listInvoicesByMemberMock.mock.calls[0];
    expect(call).toBeDefined();
    const input = call![1] as { status?: string; memberId?: string };
    expect(input.status).toBe('issued');
    expect(input.memberId).toBe('mem-1');
  });

  it('F-02: preserves newest-first ordering from the use-case (issueDate desc)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });
    // The underlying Drizzle repo orders by desc(issueDate) — the
    // route must NOT reorder. Seed the mock with three rows in that
    // order and assert the response index matches 1:1.
    listInvoicesByMemberMock.mockResolvedValueOnce(
      ok({
        rows: [
          {
            invoiceId: 'inv-newest',
            documentNumber: { toString: () => 'TSCC-2026-0009' },
            total: { satang: 30_000_00n },
            currency: 'THB',
          },
          {
            invoiceId: 'inv-mid',
            documentNumber: { toString: () => 'TSCC-2026-0008' },
            total: { satang: 20_000_00n },
            currency: 'THB',
          },
          {
            invoiceId: 'inv-oldest',
            documentNumber: { toString: () => 'TSCC-2026-0007' },
            total: { satang: 10_000_00n },
            currency: 'THB',
          },
        ],
        total: 3,
      }),
    );

    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest());
    const body = (await res.json()) as {
      invoices: Array<{ id: string }>;
    };
    expect(body.invoices[0]?.id).toBe('inv-newest');
    expect(body.invoices[2]?.id).toBe('inv-oldest');
  });

  it('429 when rate-limited', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 30_000,
    });
    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest('TSCC'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('500 on repo error', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      reset: Date.now() + 60_000,
    });
    listInvoicesByMemberMock.mockResolvedValueOnce(
      err({ type: 'repo_error', cause: new Error('boom') }),
    );
    const { GET } = await import('@/app/api/portal/invoices/search/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
