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
const countStuckErasuresInTxMock = vi.fn();
const buildEraseMemberDepsMock = vi.fn();
const erasureOutcomeMock = vi.fn();
const erasureStuckCountMock = vi.fn();

const envMock = {
  features: { memberErasureReconcile: true },
  flags: { readOnlyMode: false },
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
    stuckCount: (...args: unknown[]) => erasureStuckCountMock(...args),
  },
}));
vi.mock('@/modules/members', () => ({
  asMemberId: (raw: string) => raw,
  eraseMember: (...args: unknown[]) => eraseMemberMock(...args),
  drizzleMemberRepo: {
    findStuckErasuresInTx: (...args: unknown[]) =>
      findStuckErasuresInTxMock(...args),
    countStuckErasuresInTx: (...args: unknown[]) =>
      countStuckErasuresInTxMock(...args),
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
  envMock.flags.readOnlyMode = false;
  eraseMemberMock.mockReset();
  runInTenantMock.mockReset();
  findStuckErasuresInTxMock.mockReset();
  countStuckErasuresInTxMock.mockReset();
  countStuckErasuresInTxMock.mockResolvedValue(0);
  buildEraseMemberDepsMock.mockReset();
  buildEraseMemberDepsMock.mockReturnValue({});
  erasureOutcomeMock.mockReset();
  erasureStuckCountMock.mockReset();
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

  it('#408 READ_ONLY_MODE on → 200 skipped; no stuck-erasure read, eraseMember NOT called', async () => {
    envMock.flags.readOnlyMode = true;
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
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
    // Spec 140 s1 review round 2 — the pause still READS the candidates (for
    // the stuck gauge), but re-drives nothing.
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

  it('spec 139 — a time budget: no new member is started after ~240 s; the rest are deferred to the next tick', async () => {
    stubStuck([
      { memberId: 'm1', reason: 'gdpr_erasure_request' },
      { memberId: 'm2', reason: 'gdpr_erasure_request' },
      { memberId: 'm3', reason: 'gdpr_erasure_request' },
    ]);
    // Each re-drive takes 130 s of wall clock: m1 starts at 0 s, m2 at 130 s,
    // and at 260 s the budget is spent, so m3 waits for the next tick.
    let nowMs = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    eraseMemberMock.mockImplementation(async (memberId: string) => {
      nowMs += 130_000;
      return ok({ memberId, erasedAt: new Date(0), cascadesComplete: true });
    });
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(eraseMemberMock.mock.calls.map((c) => c[0])).toEqual(['m1', 'm2']);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({ processed: 2, reconciled: 2, still_pending: 0, error: 0, deferred: 1 });
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

  /**
   * Spec 140 s1 — the stuck-erasure gauge. Every member this sweep finds
   * has already missed its `member_erased` once, so what is still stuck at the
   * end of a tick (still_pending + error + deferred) is the signal that an
   * erasure is being re-driven tick after tick (a permanent Resend answer, a
   * cascade that never clears). Review round 1: observed as a BASELINE
   * (`stuck.length`) before the loop, so a tick killed mid-loop still leaves
   * this tick's number, then the end-of-tick value; 0 when the kill switch is
   * off; nothing new on a candidate-query failure (documented).
   */
  it('the stuck gauge: the candidate count before the loop, then still_pending + error + deferred', async () => {
    stubStuck([
      { memberId: 'm1', reason: 'gdpr_erasure_request' },
      { memberId: 'm2', reason: 'gdpr_erasure_request' },
      { memberId: 'm3', reason: 'gdpr_erasure_request' },
    ]);
    eraseMemberMock
      .mockResolvedValueOnce(ok({ memberId: 'm1', erasedAt: new Date(), cascadesComplete: false }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok({ memberId: 'm3', erasedAt: new Date(), cascadesComplete: true }));
    // Review round 4 (code-review #7) — ONE meaning: the uncapped count, before
    // the loop (the baseline a killed tick leaves) and after it.
    countStuckErasuresInTxMock.mockResolvedValueOnce(70).mockResolvedValueOnce(68);
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(erasureStuckCountMock.mock.calls).toEqual([
      [70, 'test-tenant'],
      [68, 'test-tenant'],
    ]);
    // The baseline lands before the first re-drive.
    expect(erasureStuckCountMock.mock.invocationCallOrder[0]!).toBeLessThan(eraseMemberMock.mock.invocationCallOrder[0]!);
  });

  // Review round 2 (code-review #7) — while paused, nothing is re-driven, so
  // the backlog GROWS: the gauge reads the real candidate count, never a 0.
  it('the stuck gauge reads the real candidate count while the kill switch is off, and is untouched when that read fails', async () => {
    envMock.features.memberErasureReconcile = false;
    stubStuck([]);
    // Review round 3 (code-review #8) — a NON-locking count, uncapped: the
    // paused tick locks no member row (no FOR UPDATE … SKIP LOCKED, which also
    // skipped a member being erased concurrently).
    countStuckErasuresInTxMock.mockResolvedValue(57);
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    const paused = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(paused.status).toBe(200);
    expect(erasureStuckCountMock.mock.calls).toEqual([[57, 'test-tenant']]);
    expect(countStuckErasuresInTxMock).toHaveBeenCalledWith(expect.anything(), 'test-tenant');
    expect(findStuckErasuresInTxMock).not.toHaveBeenCalled();
    expect(eraseMemberMock).not.toHaveBeenCalled();

    erasureStuckCountMock.mockReset();
    runInTenantMock.mockRejectedValueOnce(new Error('db down'));
    const pausedFailed = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(pausedFailed.status).toBe(200);
    expect(erasureStuckCountMock).not.toHaveBeenCalled();

    erasureStuckCountMock.mockReset();
    envMock.features.memberErasureReconcile = true;
    runInTenantMock.mockRejectedValueOnce(new Error('db down'));
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(erasureStuckCountMock).not.toHaveBeenCalled();
  });

  it('passes each re-drive a deadline inside maxDuration (the cascade bounds its terminal pass)', async () => {
    stubStuck([{ memberId: 'm1', reason: 'gdpr_erasure_request' }]);
    eraseMemberMock.mockResolvedValueOnce(ok({ memberId: 'm1', erasedAt: new Date(), cascadesComplete: true }));
    const before = Date.now();
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const meta = eraseMemberMock.mock.calls[0]![2] as { deadlineAt?: Date };
    expect(meta.deadlineAt).toBeInstanceOf(Date);
    // Review round 4 (senior-tester) — the exact rule, not just "some time":
    // start + maxDuration − the reserve, within the test's own run time.
    const { ERASURE_CASCADE_RESERVE_MS } = await import('@/lib/erasure-cascade-deadline');
    const expected = before + 300_000 - ERASURE_CASCADE_RESERVE_MS;
    expect(meta.deadlineAt!.getTime()).toBeGreaterThanOrEqual(expected);
    expect(meta.deadlineAt!.getTime() - expected).toBeLessThan(5_000);
  });

  it('the stuck gauge is observed as 0 on a tick that finds nothing stuck', async () => {
    stubStuck([]);
    const { POST } = await import(
      '@/app/api/cron/members/reconcile-erasures/route'
    );
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(erasureStuckCountMock).toHaveBeenCalledWith(0, 'test-tenant');
  });
});
