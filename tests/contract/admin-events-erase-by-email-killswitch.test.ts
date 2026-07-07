/**
 * F6 remediation PR 2.2 / P4 follow-up — Isolated kill-switch test for the
 * by-email bulk erasure route. Split into its own file because
 * `vi.mock('@/lib/env', ...)` permanently pollutes the worker's module cache
 * (Vitest 2.x ESM); the sibling `admin-events-erase-by-email.test.ts` keeps the
 * flag ON so the rest of the contract grid can fire.
 *
 * Verifies: with `FEATURE_F6_EVENTCREATE=false` AND an authenticated admin
 * session, the route still returns 404 and the erase fan-out is NEVER
 * dispatched (surface-disclosure prevention). Mirrors
 * `admin-registration-erase-killswitch.test.ts`.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NextRequest } from 'next/server';

const ADMIN_SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000abc',
    email: 'admin@example.com',
    role: 'admin' as const,
  },
};

const getCurrentSessionMock = vi.fn();
const runEraseAttendeesByEmailMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: getCurrentSessionMock,
}));

vi.mock('@/lib/events-admin-deps', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/events-admin-deps')>(
      '@/lib/events-admin-deps',
    );
  return {
    ...actual,
    runEraseAttendeesByEmail: runEraseAttendeesByEmailMock,
  };
});

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f6EventCreate: false },
      tenant: { slug: 'test-swecham' },
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeAll(async () => {
  await import('@/app/api/admin/events/erasure/route');
});

describe('PR 2.2 follow-up — by-email erasure kill-switch isolation', () => {
  vi.setConfig({ testTimeout: 90_000 });

  it('returns 404 when FEATURE_F6_EVENTCREATE is false (even with admin session)', async () => {
    getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
    const { POST } = (await import(
      '@/app/api/admin/events/erasure/route'
    )) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      new NextRequest('http://test/api/admin/events/erasure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'subject@example.com',
          reasonText: 'GDPR Art. 17 request',
        }),
      }),
    );
    expect(res.status).toBe(404);
    expect(runEraseAttendeesByEmailMock).not.toHaveBeenCalled();
  });
});
