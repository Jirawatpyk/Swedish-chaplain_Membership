/**
 * Contract test — POST /api/admin/insights/dismiss (F9 US1 / FR-004).
 *
 * The only F9 write surface. Verifies the HTTP auth/role/flag gating that the
 * route enforces around the (separately-tested) `dismissInsight` use-case:
 *   feature-off → 503, no session → 401, member → 403, invalid body → 400,
 *   use-case forbidden → 403, ok → 200.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

let f9Flag = true;
let sessionResult: { user: { id: string; role: 'admin' | 'manager' | 'member' } } | null = null;
const dismissInsightMock = vi.fn();

vi.mock('@/lib/env', () => ({
  env: { features: { get f9Dashboard() { return f9Flag; } } },
}));
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => Promise.resolve(sessionResult),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));
vi.mock('@/modules/insights', () => ({
  dismissInsight: (...args: unknown[]) => dismissInsightMock(...args),
  makeDismissInsightDeps: () => ({}),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'MockError' }));

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/admin/insights/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  return import('@/app/api/admin/insights/dismiss/route');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f9Flag = true;
  sessionResult = null;
  dismissInsightMock.mockResolvedValue(ok(undefined));
});
afterEach(() => vi.clearAllMocks());

const admin = { user: { id: 'u-admin', role: 'admin' as const } };

describe('POST /api/admin/insights/dismiss', () => {
  it('returns 503 when FEATURE_F9_DASHBOARD is off', async () => {
    f9Flag = false;
    sessionResult = admin;
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'at_risk_followup' }));
    expect(res.status).toBe(503);
  });

  it('returns 401 when there is no session', async () => {
    sessionResult = null;
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'at_risk_followup' }));
    expect(res.status).toBe(401);
    expect(dismissInsightMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a member (staff-only, FR-007a)', async () => {
    sessionResult = { user: { id: 'u-mem', role: 'member' } };
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'at_risk_followup' }));
    expect(res.status).toBe(403);
    expect(dismissInsightMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body (missing insightKey)', async () => {
    sessionResult = admin;
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ nope: true }));
    expect(res.status).toBe(400);
    expect(dismissInsightMock).not.toHaveBeenCalled();
  });

  it('returns 200 when the use-case succeeds', async () => {
    sessionResult = admin;
    dismissInsightMock.mockResolvedValue(ok(undefined));
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'at_risk_followup' }));
    expect(res.status).toBe(200);
    expect(dismissInsightMock).toHaveBeenCalledOnce();
  });

  it('maps use-case forbidden → 403', async () => {
    sessionResult = { user: { id: 'u-mgr', role: 'manager' } };
    dismissInsightMock.mockResolvedValue(err('forbidden'));
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'at_risk_followup' }));
    expect(res.status).toBe(403);
  });

  it('maps use-case invalid_insight_key → 400', async () => {
    sessionResult = admin;
    dismissInsightMock.mockResolvedValue(err('invalid_insight_key'));
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ insightKey: 'bogus' }));
    expect(res.status).toBe(400);
  });
});
