/**
 * 108 T014 (US1, FR-005/FR-006) — contract: POST
 * /api/portal/invoices/[invoiceId]/resend.
 *
 * A member-portal resend is triggered by whoever is signed in — and since F3 a
 * SECONDARY contact can hold a portal login. The mail itself goes to the
 * member's live primary contact (FR-001), which means the 202 body must not
 * echo that address back: doing so tells the person who clicked "resend" what
 * another individual's email address is, from a route that never authorised
 * them to know it. The body is therefore exactly `{ ok: true }` — the client
 * toast never read the field.
 *
 * The other half of the contract: when the member has no live primary contact
 * there is nothing to send to, so the use case returns `no_recipient` and the
 * route surfaces 409 (actionable by staff) rather than a success toast for mail
 * nobody receives.
 *
 * Member-context + the use case are mocked; no DB or session machinery runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const resendPdfMock = vi.fn();
const rateLimitCheckMock = vi.fn(async () => ({ success: true, reset: 0 }));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/modules/invoicing', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/invoicing')>('@/modules/invoicing');
  return {
    ...actual,
    resendPdf: (...args: unknown[]) => resendPdfMock(...args),
    makeResendPdfDeps: () => ({}),
  };
});
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...(args as [])) },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const memberContext = {
  current: { user: { id: 'user-secondary', role: 'member' } },
  tenant: { slug: 'test-swecham' },
  member: { memberId: 'mem-1' },
  memberId: 'mem-1',
  requestId: 'req-resend-1',
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/portal/invoices/inv-1/resend', {
    method: 'POST',
  });
}

async function callRoute() {
  const { POST } = await import('@/app/api/portal/invoices/[invoiceId]/resend/route');
  return POST(makeRequest(), { params: Promise.resolve({ invoiceId: 'inv-1' }) });
}

afterEach(() => {
  vi.clearAllMocks();
  rateLimitCheckMock.mockResolvedValue({ success: true, reset: 0 });
});

describe('POST /api/portal/invoices/[invoiceId]/resend (108 FR-006)', () => {
  it('202 body is exactly { ok: true } — no recipient address', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    resendPdfMock.mockResolvedValue(
      ok({ documentNumber: 'SC-2026-0001', recipientEmail: 'primary@acme.example' }),
    );

    const res = await callRoute();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true });
    // Not merely "not asserted" — the address must be absent, and no other key
    // may smuggle it either.
    expect(Object.keys(body)).toEqual(['ok']);
    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('does not disclose the address even though the use case returns one', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    resendPdfMock.mockResolvedValue(
      ok({ documentNumber: 'SC-2026-0001', recipientEmail: 'someone-else@acme.example' }),
    );

    const res = await callRoute();

    expect(await res.text()).not.toContain('someone-else@acme.example');
  });

  it('409 no_recipient when the member has no live primary contact', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    resendPdfMock.mockResolvedValue(err({ code: 'no_recipient' }));

    const res = await callRoute();
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('no_recipient');
  });

  it('keeps collapsing forbidden onto an opaque 404 (member enumeration defence)', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    resendPdfMock.mockResolvedValue(err({ code: 'forbidden' }));

    const res = await callRoute();
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('resolves the recipient itself — the route passes no address in', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    resendPdfMock.mockResolvedValue(ok({ documentNumber: 'SC-2026-0001' }));

    await callRoute();

    const input = resendPdfMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toBeDefined();
    expect(input.recipientEmailOverride).toBeUndefined();
    expect(Object.keys(input)).not.toContain('recipientEmailOverride');
  });
});
