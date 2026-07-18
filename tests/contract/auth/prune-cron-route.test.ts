/**
 * Contract test: POST(/GET) /api/cron/auth/prune-expired-invitations
 * (Staff Invitation Lifecycle, Task 7).
 *
 * Exposes Task 6's `pruneExpiredInvitations` use case behind the shared
 * `gateCronBearerOrRespond` Bearer gate (mirrors
 * `src/app/api/cron/renewals/prune-consumed-tokens/route.ts`). Wire-contract
 * surfaces only — the use case's own DELETE/audit behavior is covered by
 * `tests/integration/auth/prune-expired-invitations.integration.test.ts`.
 *
 *   - gate rejects (bad/missing Bearer)        → whatever status the gate
 *                                                 returned; use case NOT called
 *   - gate passes + READ_ONLY_MODE=false        → 200 {prunedCount:N}
 *   - gate passes + READ_ONLY_MODE=true         → 200 {skipped:true}; use
 *                                                 case NOT called (GET is
 *                                                 not covered by the proxy
 *                                                 write-freeze, and prune
 *                                                 DELETEs rows)
 *
 * Mock style mirrors `tests/contract/cron/f6-recompute-match-rate.test.ts`
 * (mock `@/lib/cron-auth` gateCronBearerOrRespond + `vi.importActual` spread
 * override on `@/lib/env`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const gateCronBearerOrRespondMock = vi.fn();
const pruneExpiredInvitationsMock = vi.fn();

vi.mock('@/lib/cron-auth', () => ({
  gateCronBearerOrRespond: (...args: unknown[]) =>
    gateCronBearerOrRespondMock(...args),
}));
vi.mock('@/modules/auth', () => ({
  pruneExpiredInvitations: (...args: unknown[]) =>
    pruneExpiredInvitationsMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function mockEnv(readOnlyMode: boolean): Promise<void> {
  vi.doMock('@/lib/env', async () => {
    const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
    return {
      ...actual,
      env: {
        ...actual.env,
        flags: { ...actual.env.flags, readOnlyMode },
      },
    };
  });
}

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/cron/auth/prune-expired-invitations',
    { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } },
  );
}

async function loadRoute() {
  return (await import(
    '@/app/api/cron/auth/prune-expired-invitations/route'
  )) as { POST: (req: NextRequest) => Promise<Response> };
}

beforeEach(() => {
  vi.resetModules();
  gateCronBearerOrRespondMock.mockReset();
  gateCronBearerOrRespondMock.mockResolvedValue(null);
  pruneExpiredInvitationsMock.mockReset();
  pruneExpiredInvitationsMock.mockResolvedValue(ok({ prunedCount: 0 }));
});

afterEach(() => {
  vi.doUnmock('@/lib/env');
  vi.clearAllMocks();
});

describe('contract: POST /api/cron/auth/prune-expired-invitations (Task 7)', () => {
  it('gate rejects → route returns the gate response; use case NOT called', async () => {
    await mockEnv(false);
    gateCronBearerOrRespondMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'unauthorized' } }), {
        status: 401,
      }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(pruneExpiredInvitationsMock).not.toHaveBeenCalled();
  });

  it('gate passes + not read-only → 200 {prunedCount:N}', async () => {
    await mockEnv(false);
    pruneExpiredInvitationsMock.mockResolvedValue(ok({ prunedCount: 3 }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prunedCount?: number };
    expect(body.prunedCount).toBe(3);
    expect(pruneExpiredInvitationsMock).toHaveBeenCalledTimes(1);
  });

  it('gate passes + READ_ONLY_MODE=true → 200 {skipped:true}; use case NOT called', async () => {
    await mockEnv(true);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('read_only_mode');
    expect(pruneExpiredInvitationsMock).not.toHaveBeenCalled();
  });
});
