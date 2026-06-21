/**
 * COMP-1 US2d — Contract test: POST /api/cron/members/reconcile-erasures.
 *
 * The reconciliation sweep re-drives the idempotent `eraseMember` for every
 * member whose erasure COMMITTED (`members.erased_at` set) but whose
 * `member_erased` completion audit never landed (a post-commit cascade failed
 * after the durable scrub tx committed). It is triggered by cron-job.org.
 *
 * Wire-contract surfaces locked here:
 *   - missing / invalid Bearer                     → 401 unauthorized, no reconcile
 *   - kill-switch off (FEATURE_MEMBER_ERASURE_RECONCILE=false) → 200 {skipped:true}
 *   - valid Bearer + 2 stuck members               → eraseMember twice + metric per
 *                                                     member + 200 summary
 *   - one re-drive THROWS                           → that member counts `error`,
 *                                                     loop continues, response 500
 *
 * Per-member outcome mapping (reconciled / still_pending / error) is asserted
 * via the summary counts. The use-case's internal cascade logic is covered by
 * the erase-member integration + unit tests; this test only locks the route
 * shell auth + kill-switch + outcome-bucketing + tick-level status code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const eraseMemberMock = vi.fn();
const runInTenantMock = vi.fn();
const findStuckErasuresInTxMock = vi.fn();
const buildEraseMemberDepsMock = vi.fn();
const erasureOutcomeMock = vi.fn();

const envMock = {
  features: { memberErasureReconcile: true },
  cron: { secret: 'test-cron-secret' },
  tenant: { slug: 'test-tenant' },
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
vi.mock('@/lib/metrics', () => ({
  erasureMetrics: {
    outcome: (...args: unknown[]) => erasureOutcomeMock(...args),
  },
}));
vi.mock('@/modules/members', () => ({
  asMemberId: (raw: string) => raw,
  eraseMember: (...args: unknown[]) => eraseMemberMock(...args),
  drizzleMemberRepo: {
    findStuckErasuresInTx: (...args: unknown[]) =>
      findStuckErasuresInTxMock(...args),
  },
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildEraseMemberDeps: (...args: unknown[]) => buildEraseMemberDepsMock(...args),
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest('http://localhost/api/cron/members/reconcile-erasures', {
    method: 'POST',
    headers,
  });
}

/** Helper: stub `runInTenant(ctx, fn)` to invoke `fn` with a fake tx and have
 *  `findStuckErasuresInTx` return the supplied stuck list. */
function stubStuck(rows: ReadonlyArray<{ memberId: string; reason: string }>) {
  findStuckErasuresInTxMock.mockResolvedValue(rows);
  runInTenantMock.mockImplementation(
    async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
  );
}

beforeEach(() => {
  envMock.features.memberErasureReconcile = true;
  eraseMemberMock.mockReset();
  runInTenantMock.mockReset();
  findStuckErasuresInTxMock.mockReset();
  buildEraseMemberDepsMock.mockReset();
  buildEraseMemberDepsMock.mockReturnValue({});
  erasureOutcomeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron reconcile-erasures — wire contract (COMP-1 US2d)', () => {
  it('(a) missing Authorization → 401, no reconcile', async () => {
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('(a) wrong Bearer token → 401, no reconcile', async () => {
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('(b) flag OFF → 200 {skipped:true}, eraseMember NOT called', async () => {
    envMock.features.memberErasureReconcile = false;
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled');
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('(c) valid Bearer + 2 stuck → eraseMember twice, metric per member, 200 both reconciled', async () => {
    stubStuck([
      { memberId: 'm1', reason: 'gdpr_erasure_request' },
      { memberId: 'm2', reason: 'pdpa_deletion_request' },
    ]);
    eraseMemberMock
      .mockResolvedValueOnce(
        ok({ memberId: 'm1', erasedAt: new Date(), cascadesComplete: true }),
      )
      .mockResolvedValueOnce(
        ok({ memberId: 'm2', erasedAt: new Date(), cascadesComplete: true }),
      );

    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));

    expect(res.status).toBe(200);
    expect(eraseMemberMock).toHaveBeenCalledTimes(2);
    // metric emitted once per member.
    expect(erasureOutcomeMock).toHaveBeenCalledTimes(2);
    expect(erasureOutcomeMock).toHaveBeenCalledWith('reconciled', 'test-tenant');
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(2);
    expect(body.reconciled).toBe(2);
    expect(body.still_pending).toBe(0);
    expect(body.error).toBe(0);
  });

  it('(c) reason is threaded through to eraseMember per member', async () => {
    stubStuck([{ memberId: 'm1', reason: 'pdpa_deletion_request' }]);
    eraseMemberMock.mockResolvedValueOnce(
      ok({ memberId: 'm1', erasedAt: new Date(), cascadesComplete: true }),
    );
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    // 2nd positional arg to eraseMember is the input { reason }.
    const callArgs = eraseMemberMock.mock.calls[0] as unknown[];
    expect(callArgs[1]).toMatchObject({ reason: 'pdpa_deletion_request' });
  });

  it('cascadesComplete=false → still_pending (not error, not reconciled), 200', async () => {
    stubStuck([{ memberId: 'm1', reason: 'gdpr_erasure_request' }]);
    eraseMemberMock.mockResolvedValueOnce(
      ok({ memberId: 'm1', erasedAt: new Date(), cascadesComplete: false }),
    );
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(erasureOutcomeMock).toHaveBeenCalledWith('still_pending', 'test-tenant');
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(1);
    expect(body.reconciled).toBe(0);
    expect(body.still_pending).toBe(1);
    expect(body.error).toBe(0);
  });

  it('typed Result.err → still_pending (transient, not error), 200', async () => {
    stubStuck([{ memberId: 'm1', reason: 'gdpr_erasure_request' }]);
    eraseMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'erase scrub failed' }),
    );
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(erasureOutcomeMock).toHaveBeenCalledWith('still_pending', 'test-tenant');
    const body = (await res.json()) as Record<string, number>;
    expect(body.still_pending).toBe(1);
    expect(body.error).toBe(0);
  });

  it('(d) one re-drive THROWS → that member counts error, loop continues, 500', async () => {
    stubStuck([
      { memberId: 'm1', reason: 'gdpr_erasure_request' },
      { memberId: 'm2', reason: 'gdpr_erasure_request' },
    ]);
    eraseMemberMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        ok({ memberId: 'm2', erasedAt: new Date(), cascadesComplete: true }),
      );

    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));

    // 500 so cron-job.org retries the tick.
    expect(res.status).toBe(500);
    // Loop continued past the throwing member to m2.
    expect(eraseMemberMock).toHaveBeenCalledTimes(2);
    expect(erasureOutcomeMock).toHaveBeenCalledWith('error', 'test-tenant');
    expect(erasureOutcomeMock).toHaveBeenCalledWith('reconciled', 'test-tenant');
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(2);
    expect(body.reconciled).toBe(1);
    expect(body.error).toBe(1);
  });

  it('candidate query fails → 500, eraseMember NOT called', async () => {
    runInTenantMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('no stuck members → 200 zeroed summary, eraseMember NOT called', async () => {
    stubStuck([]);
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(0);
    expect(body.reconciled).toBe(0);
    expect(body.still_pending).toBe(0);
    expect(body.error).toBe(0);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });
});
