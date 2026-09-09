/**
 * 108 PR-C review (2026-09-07, errors HIGH-4) — contract test for the F7 MVP
 * dispatch-scheduled cron route shell. The route had no test that reached a
 * row, so the `dispatch.server_error` branch (a tick that could not BUILD the
 * audience) was log-only with nothing pinning what it does: the row must stay
 * `approved` for the next tick (no transition, no notification — that budget
 * is FR-021's, on the Resend branch) AND the failure must be COUNTED, because
 * a broadcast slipping its schedule forever had no alertable signal.
 *
 * Wire-contract surfaces:
 *   - missing / wrong Authorization       → 401 unauthorized
 *   - F7 master flag off                  → 200 + skipped:true
 *   - valid bearer + zero eligible rows   → 200 + processed:0
 *   - one eligible row, use-case answers `dispatch.server_error` →
 *     200, `retryable: 1`, `dispatchResolveFailedTotal(tenant)` observed once,
 *     the use case was called with the row's broadcast id.
 *
 * The per-broadcast behaviour itself is pinned in
 * `tests/unit/broadcasts/application/dispatch-scheduled-broadcast.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';
import { logger } from '@/lib/logger';

const runInTenantMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn(() => true);
const isF7ImportAudienceEnabledMock = vi.fn(() => false);
const buildAudienceTickMock = vi.fn();
const dispatchScheduledBroadcastMock = vi.fn();
const dispatchResolveFailedTotalSpy = vi.fn();
const cronSkippedCountSpy = vi.fn();
const cronUnknownErrorCountSpy = vi.fn();

const envMock = {
  cron: { secret: 'test-cron-secret' },
  features: { f7Broadcasts: true },
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({ env: envMock }));
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
vi.mock('@/lib/otel-tracer', () => ({
  broadcastsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: () => void; setStatus: () => void }) => Promise<unknown>,
  ) => fn({ setAttribute: () => undefined, setStatus: () => undefined }),
}));
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      dispatchResolveFailedTotal: (...args: unknown[]) => dispatchResolveFailedTotalSpy(...args),
      cronSkippedCount: (...args: unknown[]) => cronSkippedCountSpy(...args),
      cronUnknownErrorCount: (...args: unknown[]) => cronUnknownErrorCountSpy(...args),
    },
  };
});
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  dispatchScheduledBroadcast: (...args: unknown[]) => dispatchScheduledBroadcastMock(...args),
  makeDispatchScheduledBroadcastDeps: async () => ({ membersBridge: { kind: 'members-bridge-stub' } }),
  makeTickMemoizedMembersBridge: (inner: unknown) => inner,
  // `SPLIT_THRESHOLD_RECIPIENTS` was mocked here for the Phase 9b claim
  // predicate. Both are gone: `ca51f59a1` deleted the batch crons and the
  // constant, and the route now references neither (`grep -c` = 0). Removed
  // rather than left as harmless padding — a fixture for a predicate that
  // cannot exist is how the assertion below went vacuous unnoticed.
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  isF7ImportAudienceEnabled: () => isF7ImportAudienceEnabledMock(),
  buildAudienceTick: (...args: unknown[]) => buildAudienceTickMock(...args),
  makeBuildAudienceTickDeps: async () => ({ kind: 'build-deps-stub' }),
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers['authorization'] = opts.auth;
  return new NextRequest('http://localhost/api/cron/broadcasts/dispatch-scheduled', {
    method: 'POST',
    headers,
  });
}

const BROADCAST_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  runInTenantMock.mockReset();
  isF71aUs1EnabledMock.mockReturnValue(true);
  isF7ImportAudienceEnabledMock.mockReturnValue(false);
  buildAudienceTickMock.mockReset();
  dispatchScheduledBroadcastMock.mockReset();
  dispatchResolveFailedTotalSpy.mockReset();
  cronSkippedCountSpy.mockReset();
  cronUnknownErrorCountSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron dispatch-scheduled — wire contract (108 PR-C review)', () => {
  it('missing Authorization → 401; wrong Bearer → 401; no query either way', async () => {
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    expect((await POST(makeRequest({}))).status).toBe(401);
    expect((await POST(makeRequest({ auth: 'Bearer wrong-secret' }))).status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(dispatchScheduledBroadcastMock).not.toHaveBeenCalled();
  });

  it('F7 master flag off → 200 + skipped, no query', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'feature_disabled' });
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('valid bearer + zero eligible rows → 200 + processed:0', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({ execute: async () => [] }));
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed?: number; skipped?: boolean };
    expect(body.processed ?? 0).toBe(0);
    expect(dispatchScheduledBroadcastMock).not.toHaveBeenCalled();
  });

  it('one eligible row answering dispatch.server_error → retryable:1, counted once, nothing else touched', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    dispatchScheduledBroadcastMock.mockResolvedValue(
      err({ kind: 'dispatch.server_error', message: 'recipient resolution unavailable' }),
    );
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body['processed']).toBe(1);
    expect(body['retryable']).toBe(1);
    expect(body['succeeded']).toBe(0);
    expect(body['permanent_failed']).toBe(0);
    expect(body['uncaught_error']).toBe(0);

    expect(dispatchScheduledBroadcastMock).toHaveBeenCalledTimes(1);
    // The ON direction pins that the legacy path is NOT taken; without its
    // mirror here the routing was only half asserted, and a fault that ran BOTH
    // paths in one tick would have passed. Both legs write to the same row.
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
    const [, input] = dispatchScheduledBroadcastMock.mock.calls[0] as [unknown, { broadcastId: string }];
    expect(input).toEqual({ broadcastId: BROADCAST_ID });
    // Review errors HIGH-4 — the alarm for a schedule slipping tick after tick.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledTimes(1);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant');
  });

  /**
   * Round 4 L3 + L4 — the two halves of what an operator can actually read when
   * a tick cannot build its audience.
   *
   * L4 is the SECOND SENTENCE of round-3 finding 3-13, which the round-3 ledger
   * recorded as fully closed (`review-20260909-092000.md:153`) while only the
   * first was addressed. The import arm incremented
   * `broadcasts.dispatch_resolve_failed.total` and logged NOTHING, so a Resend
   * 5xx raised a counter whose runbook triage tree is F3 pages / Neon /
   * opt-out lookup, with no line on that leg to correct the reading.
   *
   * L3 is why the field is `errClass` and not `reason`: `reason` and `*.reason`
   * are REDACT_PATHS (`logger.ts:332`), deliberately broad because free text
   * here can carry a Neon error's bound parameters — member addresses. The
   * legacy arm printed `reason:"[REDACTED]"` for exactly that reason. Renaming
   * the key would have un-redacted the address; the class is the bounded half.
   */
  it('Round 4 L3/L4 — the import arm logs a bounded errClass, and no free text reaches the log', async () => {
    isF7ImportAudienceEnabledMock.mockReturnValue(true);
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    buildAudienceTickMock.mockResolvedValue(
      err({
        kind: 'dispatch.server_error',
        // A realistic Neon message: the bound parameter is a member address.
        message: 'error: relation "contacts" — params: [alice@example.com]',
        errClass: 'NeonDbError',
      }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body['retryable']).toBe(1);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledTimes(1);

    const warn = vi
      .mocked(logger.warn)
      .mock.calls.find(([, msg]) => msg === 'cron.broadcasts.dispatch.server_error');
    expect(warn, 'the import arm must LOG, not only count (3-13 second half)').toBeDefined();

    const fields = warn?.[0] as Record<string, unknown>;
    expect(fields['errClass']).toBe('NeonDbError');
    // The two things that must never come back: a key the redactor blanks, and
    // the address itself anywhere in the line.
    expect(fields).not.toHaveProperty('reason');
    expect(JSON.stringify(fields)).not.toContain('alice@example.com');
  });

  /**
   * T087 (108 US5) — with the import flag ON the cron routes to
   * `buildAudienceTick` and `dispatchScheduledBroadcast` is never called.
   *
   * Two separate use cases rather than one with a branch inside: the
   * single-tick path is ~1,200 lines of orphan reuse, idempotency replay,
   * retry budget and batch hand-off, and giving all of it two shapes would
   * make its suite the regression surface for both. The route is the ONLY
   * place that knows both exist.
   */
  it('import flag ON → buildAudienceTick runs and the single-tick path does not', async () => {
    isF7ImportAudienceEnabledMock.mockReturnValue(true);
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    buildAudienceTickMock.mockResolvedValue({
      ok: true,
      value: { kind: 'import_submitted', importId: 'imp-1', recipientCount: 3 },
    });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);

    expect(buildAudienceTickMock).toHaveBeenCalledTimes(1);
    expect(dispatchScheduledBroadcastMock).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, number>;
    expect(body['processed']).toBe(1);
    // An import submitted is neither a success nor a failure: nothing has been
    // delivered, and the next tick confirms it. Counting it as `succeeded`
    // would make the dashboard claim a send that has not happened.
    expect(body['import_submitted']).toBe(1);
    expect(body['succeeded']).toBe(0);
  });

  it('import flag ON → the claim query has NO count bound, so a large audience reaches this cron', async () => {
    // With the import there is no per-tick capacity to partition around: one
    // call carries the whole audience. Keeping the batching predicate would
    // hand a >500 row to `split-large-broadcasts`, which would build manifests
    // for a path that is no longer the one used.
    isF7ImportAudienceEnabledMock.mockReturnValue(true);
    const executed: unknown[] = [];
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async (q: unknown) => {
          executed.push(q);
          return [];
        },
      }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));

    // POSITIVE CONTROL FIRST. The `not.toContain` below is asserting the
    // absence of a predicate that no longer exists in ANY flag state, so on its
    // own it also passes when `sqlTextOf` returns '' for an unrelated reason —
    // a changed query shape, a different mock arg, a refactor of the helper.
    // Anchor on clauses the claim query must keep, or this case proves nothing.
    const claimSql = sqlTextOf(executed[0]);
    expect(claimSql).toContain("status = 'approved'");
    expect(claimSql).toContain('scheduled_for');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');

    expect(claimSql).not.toContain('estimated_recipient_count');
  });

  it('import flag ON and the tick reports sent → counted as succeeded', async () => {
    isF7ImportAudienceEnabledMock.mockReturnValue(true);
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    buildAudienceTickMock.mockResolvedValue({
      ok: true,
      value: { kind: 'sent', resendBroadcastId: 'rb-1', recipientCount: 3 },
    });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['succeeded']).toBe(1);
  });

  it('import flag ON and the completion rule refuses → permanent_failed, not retryable', async () => {
    // A refused completion is terminal by design: every reason is a statement
    // about a job that has already finished, so re-polling produces the same
    // answer. Counting it retryable would hide it in a bucket that is expected
    // to clear on its own.
    isF7ImportAudienceEnabledMock.mockReturnValue(true);
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    buildAudienceTickMock.mockResolvedValue({
      ok: false,
      error: {
        kind: 'audience_import_failed',
        reason: 'count_mismatch',
        importId: 'imp-1',
        observed: 0,
        expected: 3,
      },
    });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['permanent_failed']).toBe(1);
    expect(body['unknown_error']).toBe(0);
  });

  /**
   * Round 2 R2-1/R2-44 + round 3 finding 3-13 — two reviews reached this from
   * opposite ends (the repo compare-and-set, and the cron switch).
   *
   * `broadcast_invalid_state_transition` and `broadcast_not_found` both mean
   * "the row is no longer what the claim query saw": a cancel landed, another
   * worker won the transition, or an erasure cascade removed it. All three are
   * NORMAL. Neither branch had an arm for either, so both fell to `default` →
   * `unknown_error` + `cronUnknownErrorCount`, which this route's own comment
   * documents as the page-on-call enum-drift signal — and which
   * `dispatch-scheduled-broadcast.ts:1076` explicitly says must NOT page
   * ("do NOT page on-call (no actual failure)") in the very arm that produces
   * the kind.
   *
   * The precedent for the bucket is already in the codebase:
   * `metrics.ts:2544` names `concurrent_skip` an *expected race*, kept apart
   * from the bucket whose non-zero rate is stop-the-line.
   *
   * The `unknown_error: 0` assertion is the load-bearing half. Counting the new
   * bucket alone would pass while the row was ALSO still paging on-call.
   */
  for (const [label, error] of [
    ['broadcast_invalid_state_transition', { kind: 'broadcast_invalid_state_transition', observedStatus: 'sending' }],
    ['broadcast_not_found', { kind: 'broadcast_not_found', broadcastId: BROADCAST_ID }],
  ] as const) {
    it(`legacy branch: ${label} → concurrent_skip, NOT unknown_error, and does not page`, async () => {
      runInTenantMock.mockImplementation(async (_ctx, fn) =>
        fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
      );
      dispatchScheduledBroadcastMock.mockResolvedValue(err(error));

      const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
      const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
      const body = (await res.json()) as Record<string, number>;
      expect(body['concurrent_skip']).toBe(1);
      expect(body['unknown_error']).toBe(0);
      expect(cronUnknownErrorCountSpy).not.toHaveBeenCalled();
      // Not a failure either — `permanent_failed` means "finished, nothing left
      // to do", which would suppress the alert if this ever WERE a real fault.
      expect(body['permanent_failed']).toBe(0);
      expect(body['retryable']).toBe(0);
    });

    it(`import branch: ${label} → concurrent_skip, NOT unknown_error, and does not page`, async () => {
      isF7ImportAudienceEnabledMock.mockReturnValue(true);
      runInTenantMock.mockImplementation(async (_ctx, fn) =>
        fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
      );
      buildAudienceTickMock.mockResolvedValue(err(error));

      const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
      const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
      const body = (await res.json()) as Record<string, number>;
      expect(body['concurrent_skip']).toBe(1);
      expect(body['unknown_error']).toBe(0);
      expect(cronUnknownErrorCountSpy).not.toHaveBeenCalled();
      expect(body['permanent_failed']).toBe(0);
      expect(body['retryable']).toBe(0);
    });
  }

  /**
   * Positive control for the four cases above: the `default` arm must STILL
   * page for a kind nobody routed. Without this, deleting the switch and
   * bucketing everything as `concurrent_skip` would pass every assertion in
   * this block — the shape that made round 1's phantom-kind stubs green.
   */
  it('an unrouted kind still reaches unknown_error and pages — the arms above are narrow, not a catch-all', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    dispatchScheduledBroadcastMock.mockResolvedValue(
      err({ kind: 'a_kind_no_switch_has_ever_heard_of' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['unknown_error']).toBe(1);
    expect(body['concurrent_skip']).toBe(0);
    expect(cronUnknownErrorCountSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Drizzle keeps a template's literal fragments in `queryChunks`. A chunk can
 * itself be a nested `SQL` (the flag-conditional predicate is one), so this
 * RECURSES — a flat map would silently miss exactly the fragment these cases
 * are about and report it as absent.
 */
function sqlTextOf(q: unknown): string {
  const node = q as { queryChunks?: unknown[]; value?: unknown } | undefined;
  if (node === undefined || node === null) return '';
  const chunks = node.queryChunks;
  if (Array.isArray(chunks)) return chunks.map(sqlTextOf).join('');
  if (typeof q === 'string') return q;
  if (Array.isArray(node.value)) return node.value.join('');
  return '';
}
