/**
 * Round 1 CR-1 / TESTS-C-1 — Isolated kill-switch test for POST /api/admin/events.
 *
 * Split into its own file because `vi.doMock('@/lib/env', ...)` permanently
 * pollutes the worker's module cache (Vitest 2.x ESM behavior). Running
 * this together with the happy-path suite makes subsequent tests see the
 * kill-switch-off env, breaking 429/500 assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: vi.fn(),
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

describe('Round 1 CR-1 — kill-switch isolation', () => {
  vi.setConfig({ testTimeout: 60_000 });

  it('returns 404 when FEATURE_F6_EVENTCREATE is false', async () => {
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
  });
});
