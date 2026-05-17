/**
 * Phase B B8 follow-up — Isolated kill-switch test for the relink route.
 * Same rationale as `admin-registration-erase-killswitch.test.ts`.
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
const VALID_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const VALID_REGISTRATION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const VALID_NEW_MEMBER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

const getCurrentSessionMock = vi.fn();
const runRelinkRegistrationMock = vi.fn();

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
    runRelinkRegistration: runRelinkRegistrationMock,
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
  await import(
    '@/app/api/admin/events/[eventId]/registrations/[registrationId]/relink/route'
  );
});

describe('Phase B B8 follow-up — relink kill-switch isolation', () => {
  vi.setConfig({ testTimeout: 90_000 });

  it('returns 404 when FEATURE_F6_EVENTCREATE is false (even with admin session)', async () => {
    getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
    const { POST } = (await import(
      '@/app/api/admin/events/[eventId]/registrations/[registrationId]/relink/route'
    )) as {
      POST: (
        req: NextRequest,
        ctx: { params: Promise<{ eventId: string; registrationId: string }> },
      ) => Promise<Response>;
    };
    const res = await POST(
      new NextRequest(
        `http://test/api/admin/events/${VALID_EVENT_ID}/registrations/${VALID_REGISTRATION_ID}/relink`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        },
      ),
      {
        params: Promise.resolve({
          eventId: VALID_EVENT_ID,
          registrationId: VALID_REGISTRATION_ID,
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(runRelinkRegistrationMock).not.toHaveBeenCalled();
  });
});
