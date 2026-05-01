/**
 * T127 — Contract test: GET /api/broadcasts/quota.
 *
 * RED-FIRST per Phase 5 (User Story 3 — member sees current quota +
 * broadcast history). Spec authority: contracts/broadcasts-api.md § 1.7.
 *
 * Verifies the response envelope shape exactly as specified:
 *   { planId, eblastPerYear, quotaYear, used, reserved, remaining,
 *     nextResetAt, tenantTimezone }
 *
 * RED expectations (current route at src/app/api/broadcasts/quota/route.ts
 * does NOT return `nextResetAt` or `tenantTimezone` — those will be added
 * during the GREEN implementation phase for US3):
 *   - `nextResetAt` MUST be ISO 8601 UTC pointing at the next-year boundary
 *     in the tenant timezone (e.g., 2027-01-01T00:00:00+07:00 → "2026-12-31T17:00:00Z").
 *   - `tenantTimezone` MUST be the IANA TZ name (e.g. "Asia/Bangkok").
 *
 * Authz / failure paths are the standard member-context guard (401 / 403)
 * + 404 when the member row cannot be resolved (probe / not_found).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const computeQuotaCounterMock = vi.fn();
const makeComputeQuotaDepsMock = vi.fn((..._args: unknown[]) => ({}));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) =>
    requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter: (...args: unknown[]) =>
    computeQuotaCounterMock(...args),
  makeComputeQuotaDeps: (...args: unknown[]) =>
    makeComputeQuotaDepsMock(...args),
}));

const memberCtx = {
  current: {
    user: {
      id: 'user-member-1',
      email: 'member@swecham.test',
      role: 'member' as const,
      status: 'active' as const,
      displayName: 'Member',
    },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'swecham', __brand: true },
  member: { memberId: 'm-1', planId: 'p-prem' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-quota-1',
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/broadcasts/quota', {
    method: 'GET',
  });
}

async function importRoute() {
  return import('@/app/api/broadcasts/quota/route');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/broadcasts/quota — T127 RED (US3 contract)', () => {
  it('200: returns the contract envelope { planId, eblastPerYear, quotaYear, used, reserved, remaining, nextResetAt, tenantTimezone }', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    computeQuotaCounterMock.mockResolvedValueOnce(
      ok({
        counter: { used: 2, reserved: 1, remaining: 3, cap: 6 },
        quotaYear: 2026,
        planCode: 'premium_corporate',
        planId: 'p-prem',
        nextResetAt: '2026-12-31T17:00:00.000Z',
        tenantTimezone: 'Asia/Bangkok',
      }),
    );

    const { GET } = await importRoute();
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Numeric counters
    expect(body).toMatchObject({
      planId: 'p-prem',
      eblastPerYear: 6,
      quotaYear: 2026,
      used: 2,
      reserved: 1,
      remaining: 3,
    });

    // Contract fields currently missing in the implementation — RED here.
    expect(body).toHaveProperty('nextResetAt');
    expect(typeof body.nextResetAt).toBe('string');
    // ISO 8601 UTC, pointing at the year-boundary in tenant TZ:
    // 2027-01-01T00:00:00+07:00 → 2026-12-31T17:00:00Z
    expect(body.nextResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(body.nextResetAt).toBe('2026-12-31T17:00:00.000Z');

    expect(body).toHaveProperty('tenantTimezone');
    expect(body.tenantTimezone).toBe('Asia/Bangkok');
  });

  it('200: remaining = eblastPerYear - used - reserved invariant holds', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    computeQuotaCounterMock.mockResolvedValueOnce(
      ok({
        counter: { used: 0, reserved: 0, remaining: 1, cap: 1 },
        quotaYear: 2026,
        planCode: 'regular_corporate',
        planId: 'p-reg',
        nextResetAt: '2026-12-31T17:00:00.000Z',
        tenantTimezone: 'Asia/Bangkok',
      }),
    );

    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eblastPerYear - body.used - body.reserved).toBe(body.remaining);
  });

  it('401 when member-context guard returns response (unauthenticated)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(computeQuotaCounterMock).not.toHaveBeenCalled();
  });

  it('404 when use-case returns quota.member_not_found', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    computeQuotaCounterMock.mockResolvedValueOnce(
      err({ kind: 'quota.member_not_found', memberId: 'm-1' }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
  });

  it('Round 4 M1 — 403 when authenticated session is admin/manager (member-only route)', async () => {
    // Regression guard: a refactor that removed the member-only guard
    // would let admins/managers exercise quota math on members they
    // don't represent — privacy hazard. Member-context guard is the
    // single chokepoint; assert the contract route refuses non-member
    // roles by surfacing the guard's 403 response verbatim.
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden_role' }, { status: 403 }),
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(computeQuotaCounterMock).not.toHaveBeenCalled();
  });

  it('500 when use-case returns quota.invariant_violation', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    computeQuotaCounterMock.mockResolvedValueOnce(
      err({
        kind: 'quota.invariant_violation',
        cause: { kind: 'quota.negative_remaining' },
      }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
