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

const runInTenantMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn(() => true);
const isF7ImportAudienceEnabledMock = vi.fn(() => false);
const buildAudienceTickMock = vi.fn();
const dispatchScheduledBroadcastMock = vi.fn();
const dispatchResolveFailedTotalSpy = vi.fn();
const cronSkippedCountSpy = vi.fn();

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
    },
  };
});
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  dispatchScheduledBroadcast: (...args: unknown[]) => dispatchScheduledBroadcastMock(...args),
  makeDispatchScheduledBroadcastDeps: async () => ({ membersBridge: { kind: 'members-bridge-stub' } }),
  makeTickMemoizedMembersBridge: (inner: unknown) => inner,
  // Phase 9b (T131/T137) — the claim query bounds on this. A FORWARDING
  // fixture: what this file pins is that the predicate exists and names the
  // column, not that 500 is the production value (that lives in
  // `audience-ceiling.test.ts`). Omitting it interpolated `undefined` into the
  // SQL and every case in this file answered 500.
  SPLIT_THRESHOLD_RECIPIENTS: 500,
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
    const [, input] = dispatchScheduledBroadcastMock.mock.calls[0] as [unknown, { broadcastId: string }];
    expect(input).toEqual({ broadcastId: BROADCAST_ID });
    // Review errors HIGH-4 — the alarm for a schedule slipping tick after tick.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledTimes(1);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant');
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

    expect(sqlTextOf(executed[0])).not.toContain('estimated_recipient_count');
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
