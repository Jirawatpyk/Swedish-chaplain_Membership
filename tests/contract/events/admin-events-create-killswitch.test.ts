/**
 * Round 1 CR-1 / TESTS-C-1 — Isolated kill-switch test for POST /api/admin/events.
 *
 * Split into its own file because `vi.doMock('@/lib/env', ...)` permanently
 * pollutes the worker's module cache (Vitest 2.x ESM behavior). Running
 * this together with the happy-path suite makes subsequent tests see the
 * kill-switch-off env, breaking 429/500 assertions.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// R2 (Round 2 — pr-test-analyzer C1): the kill-switch test must mock an
// authenticated admin session so the kill-switch guard at the top of
// the route is the ONLY code path that can produce a 404. Previously
// the mock returned `undefined` (no session) → 404 from `if (!session)`
// regardless of the kill-switch — a regression that flips the guard
// ordering or removes the kill-switch check would have passed silently.
const ADMIN_SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000abc',
    email: 'admin@example.com',
    role: 'admin' as const,
  },
};
const getCurrentSessionMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: getCurrentSessionMock,
}));

// Mock the create-event composition adapter so we can assert it is NEVER
// called when the kill-switch is OFF — proves the early 404 short-
// circuited BEFORE use-case dispatch.
const runCreateEventMock = vi.fn();
vi.mock('@/lib/events-create-deps', () => ({
  runCreateEvent: runCreateEventMock,
  createEventRateLimitCheck: vi.fn(async () => ({
    success: true,
    resetAtUnixMs: Date.now() + 3_600_000,
  })),
  asUserId: (s: string) => s,
}));

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

// Staff-review R3v2 (2026-05-16): pre-warm the route module + bump
// testTimeout. The file has a single test whose 26.8s file-total IS
// the cold-import cost (only 1 it() body). Under `pnpm test:coverage`
// 2× instrumentation = ~54s; 3× = ~80s. Pre-warm into the 60s
// hookTimeout (vitest.config.ts) + bump testTimeout to 90s to cover
// the worst-case CI run.
beforeAll(async () => {
  await import('@/app/api/admin/events/route');
});

describe('Round 1 CR-1 — kill-switch isolation', () => {
  vi.setConfig({ testTimeout: 90_000 });

  it('returns 404 when FEATURE_F6_EVENTCREATE is false (even with admin session)', async () => {
    // R2 fix: stub an authenticated admin session so the ONLY 404
    // trigger left is the kill-switch guard. The use-case mock must
    // not be called.
    getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
    const { POST } = (await import('@/app/api/admin/events/route')) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
    const res = await POST(
      new NextRequest('http://test/api/admin/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalId: 'test-event',
          name: 'Test',
          startDate: '2026-03-20T18:00:00+07:00',
          category: null,
        }),
      }),
    );
    expect(res.status).toBe(404);
    // Critical R2 assertion: runCreateEvent MUST NOT be dispatched
    // when kill-switch is OFF. Without this, a future refactor that
    // moves the kill-switch below the session check + leaves admin
    // session active would still pass `expect(res.status).toBe(404)`
    // because of unrelated guards.
    expect(runCreateEventMock).not.toHaveBeenCalled();
  });
});
