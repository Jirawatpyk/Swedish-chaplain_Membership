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
 * Spec 140 s4 deleted the legacy dispatch leg and its import flag: the route
 * drives `buildAudienceTick` alone, and this file keeps only its cases (the
 * legacy-only ones went with the leg). The per-broadcast behaviour itself is
 * pinned in `tests/unit/broadcasts/application/build-audience-tick*.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';
import { logger } from '@/lib/logger';

const runInTenantMock = vi.fn();
// Round 4, whole-branch review #11 — kept ONLY because the `vi.mock` factory
// below still lists the export. The route no longer imports `isF71aUs1Enabled`
// (the pagination flag gates nothing since `ca51f59a1`), so this mock steers
// nothing; it is fixture debris, not coverage.
const isF71aUs1EnabledMock = vi.fn(() => true);
const buildAudienceTickMock = vi.fn();
const dispatchResolveFailedTotalSpy = vi.fn();
const cronSkippedCountSpy = vi.fn();
const cronUnknownErrorCountSpy = vi.fn();
const dispatchLeaseExpiringSpy = vi.fn();
const buildDepsArgs: unknown[][] = [];
/** Spec 140 s2a review round 3 — every `setAttribute` the route span receives. */
const spanAttributes = new Map<string, unknown>();

const envMock = {
  cron: { secret: 'test-cron-secret' },
  features: { f7Broadcasts: true },
  flags: { readOnlyMode: false },
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({ env: envMock }));
// F119 T031 — the brand seam is composed over the invoicing barrel; this wire
// test is about the cron's routing, so the seam is a no-brand stub.
vi.mock('@/lib/broadcast-brand-deps', () => ({
  brandChromePort: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
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
vi.mock('@/lib/otel-tracer', () => ({
  broadcastsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: (key: string, value: unknown) => void; setStatus: () => void }) => Promise<unknown>,
  ) =>
    fn({
      setAttribute: (key: string, value: unknown) => {
        spanAttributes.set(key, value);
      },
      setStatus: () => undefined,
    }),
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
      dispatchLeaseExpiring: (...args: unknown[]) => dispatchLeaseExpiringSpy(...args),
    },
  };
});
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  // `SPLIT_THRESHOLD_RECIPIENTS` was mocked here for the Phase 9b claim
  // predicate. Both are gone: `ca51f59a1` deleted the batch crons and the
  // constant, and the route now references neither (`grep -c` = 0). Removed
  // rather than left as harmless padding — a fixture for a predicate that
  // cannot exist is how the assertion below went vacuous unnoticed.
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  buildAudienceTick: (...args: unknown[]) => buildAudienceTickMock(...args),
  // Spec 140 s4 (security L7) — a distinctive value, so the log assertion
  // below can only pass if the route read this function.
  currentAudienceCeiling: () => 777,
  makeBuildAudienceTickDeps: async (...args: unknown[]) => {
    buildDepsArgs.push(args);
    // Like the real maker: the tick budget (its second argument, spec 140 s4)
    // rides the deps. The maker builds its own members-bridge memo, so it takes
    // no bridge; that wiring is pinned in `broadcasts-deps-audience.test.ts`.
    return { kind: 'build-deps-stub', tickBudget: args[1] };
  },
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

function oneRow(): void {
  runInTenantMock.mockImplementation(async (_ctx, fn) =>
    fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
  );
}

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  envMock.flags.readOnlyMode = false;
  runInTenantMock.mockReset();
  isF71aUs1EnabledMock.mockReturnValue(true);
  buildAudienceTickMock.mockReset();
  dispatchResolveFailedTotalSpy.mockReset();
  cronSkippedCountSpy.mockReset();
  cronUnknownErrorCountSpy.mockReset();
  buildDepsArgs.length = 0;
  spanAttributes.clear();
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
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
  });

  // Spec 140 s4 (row 2) — the kill switch still runs before any deps are built.
  it('the kill-switch arm builds no import deps', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(await res.json()).toEqual({ skipped: true, reason: 'feature_disabled' });
    expect(buildDepsArgs).toHaveLength(0);
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
  });

  it('F7 master flag off → 200 + skipped, no query', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'feature_disabled' });
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('#408 READ_ONLY_MODE on → 200 skipped; no claim query, nothing dispatched', async () => {
    envMock.flags.readOnlyMode = true;
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
  });

  it('#408 READ_ONLY_MODE on + wrong Bearer → still 401 (the freeze state is not leaked)', async () => {
    envMock.flags.readOnlyMode = true;
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    expect((await POST(makeRequest({ auth: 'Bearer wrong-secret' }))).status).toBe(401);
  });

  it('valid bearer + zero eligible rows → 200 + processed:0', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({ execute: async () => [] }));
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed?: number; skipped?: boolean };
    expect(body.processed ?? 0).toBe(0);
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
  });

  // PR #756 review round 1 (code-review #3) — the maker does a dynamic import, a
  // tenant display-name read and a memo per call: an empty tick builds none of
  // it, and keeps its metric, its body and its tick_complete line.
  it('a tick with no due rows builds no import deps', async () => {
    vi.mocked(logger.info).mockClear();
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({ execute: async () => [] }));
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body['processed']).toBe(0);
    expect(buildDepsArgs).toHaveLength(0);
    expect(buildAudienceTickMock).not.toHaveBeenCalled();
    expect(cronSkippedCountSpy).toHaveBeenCalledWith('test-tenant', 'no_due_rows');
    const completes = vi
      .mocked(logger.info)
      .mock.calls.filter(([, msg]) => msg === 'cron.broadcasts.dispatch.tick_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.[0]).toMatchObject({ tenantId: 'test-tenant', audienceCeiling: 777, processed: 0 });
  });

  // Spec 140 s4 (security L7) — the effective ceiling is logged once per tick,
  // on the tick_complete line only: not a summary bucket, so neither the JSON
  // body nor the `cron.<key>` span attributes carry it.
  it('tick_complete logs the effective audience ceiling once, outside the summary', async () => {
    vi.mocked(logger.info).mockClear();
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({ execute: async () => [] }));
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, unknown>;
    const completes = vi
      .mocked(logger.info)
      .mock.calls.filter(([, msg]) => msg === 'cron.broadcasts.dispatch.tick_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.[0]).toMatchObject({ tenantId: 'test-tenant', audienceCeiling: 777 });
    expect(body).not.toHaveProperty('audienceCeiling');
    expect([...spanAttributes.keys()].some((k) => k.includes('audienceCeiling'))).toBe(false);
  });

  it('one eligible row answering dispatch.server_error → retryable:1, counted once, nothing else touched', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue(
      err({ kind: 'dispatch.server_error', message: 'recipient resolution unavailable', phase: 'resolve' }),
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

    expect(buildAudienceTickMock).toHaveBeenCalledTimes(1);
    const [, input] = buildAudienceTickMock.mock.calls[0] as [unknown, { broadcastId: string }];
    expect(input).toEqual({ broadcastId: BROADCAST_ID });
    // Review errors HIGH-4 — the alarm for a schedule slipping tick after tick.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledTimes(1);
    // 2026-09-10 follow-up (5) — the PHASE label, by value. Without it the
    // counter said "resolve failed" for a persist fault and the unknown-status
    // refusal alike.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant', 'resolve');
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
    oneRow();
    buildAudienceTickMock.mockResolvedValue(
      err({
        kind: 'dispatch.server_error',
        // A realistic Neon message: the bound parameter is a member address.
        message: 'error: relation "contacts" — params: [alice@example.com]',
        errClass: 'NeonDbError',
        phase: 'resolve',
      }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body['retryable']).toBe(1);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledTimes(1);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant', 'resolve');

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
   * T087 (108 US5) — the cron drives `buildAudienceTick`, the only dispatch leg
   * since spec 140 s4. An import submitted is its own bucket.
   */
  it('one eligible row → buildAudienceTick runs; an import submitted counts import_submitted, not succeeded', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({
      ok: true,
      value: { kind: 'import_submitted', importId: 'imp-1', recipientCount: 3 },
    });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);

    expect(buildAudienceTickMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as Record<string, number>;
    expect(body['processed']).toBe(1);
    // An import submitted is neither a success nor a failure: nothing has been
    // delivered, and the next tick confirms it. Counting it as `succeeded`
    // would make the dashboard claim a send that has not happened.
    expect(body['import_submitted']).toBe(1);
    expect(body['succeeded']).toBe(0);
  });

  it('the claim query has NO count bound, so a large audience reaches this cron', async () => {
    // With the import there is no per-tick capacity to partition around: one
    // call carries the whole audience.
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
    // absence of a predicate that no longer exists, so on its own it also
    // passes when `sqlTextOf` returns '' for an unrelated reason — a changed
    // query shape, a different mock arg, a refactor of the helper. Anchor on
    // clauses the claim query must keep, or this case proves nothing.
    const claimSql = sqlTextOf(executed[0]);
    expect(claimSql).toContain("status = 'approved'");
    expect(claimSql).toContain('scheduled_for');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');

    expect(claimSql).not.toContain('estimated_recipient_count');
    // Spec 140 s4 — and no import-row filter: the import tick works every
    // approved row, including one it started (the legacy leg's DL7 skip went
    // with that leg).
    expect(claimSql).not.toContain('audience_import_id IS NULL');
    expect(claimSql).not.toContain('audience_import_submitted_at IS NULL');
  });

  it('the tick reports sent → counted as succeeded', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({
      ok: true,
      value: { kind: 'sent', resendBroadcastId: 'rb-1', recipientCount: 3 },
    });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['succeeded']).toBe(1);
  });

  it('the completion rule refuses → permanent_failed, not retryable', async () => {
    // A refused completion is terminal by design: every reason is a statement
    // about a job that has already finished, so re-polling produces the same
    // answer. Counting it retryable would hide it in a bucket that is expected
    // to clear on its own.
    oneRow();
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
   * NORMAL. The switch had an arm for neither, so both fell to `default` →
   * `unknown_error` + `cronUnknownErrorCount`, which this route's own comment
   * documents as the page-on-call enum-drift signal.
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
    it(`${label} → concurrent_skip, NOT unknown_error, and does not page`, async () => {
      oneRow();
      buildAudienceTickMock.mockResolvedValue(err(error));

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
  }

  /**
   * Positive control for the cases above: the `default` arm must STILL page
   * for a kind nobody routed. Without this, deleting the switch and bucketing
   * everything as `concurrent_skip` would pass every assertion in this block —
   * the shape that made round 1's phantom-kind stubs green. Spec 140 s4 made
   * the switch exhaustive (`never`); at runtime a kind the type does not know
   * still lands here and pages, never accepted silently.
   */
  it('an unrouted kind still reaches unknown_error and pages — the arms above are narrow, not a catch-all', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue(err({ kind: 'a_kind_no_switch_has_ever_heard_of' }));

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['unknown_error']).toBe(1);
    expect(body['concurrent_skip']).toBe(0);
    expect(cronUnknownErrorCountSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ broadcastId: BROADCAST_ID, errorKind: 'a_kind_no_switch_has_ever_heard_of' }),
      'cron.broadcasts.dispatch.unknown_error_kind',
    );
  });

  // PR #756 review round 1 (rel L3) — the success chain ended in a bare `else`
  // that counted ANY other kind `import_pending`. It is an exhaustive switch now,
  // so a success kind no arm knows pages like an unknown error kind does.
  it('an unrouted SUCCESS kind reaches unknown_error and pages, not import_pending', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'a_success_no_switch_has_heard_of' } });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['unknown_error']).toBe(1);
    expect(body['import_pending']).toBe(0);
    expect(cronUnknownErrorCountSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ broadcastId: BROADCAST_ID, outcomeKind: 'a_success_no_switch_has_heard_of' }),
      'cron.broadcasts.dispatch.unknown_outcome_kind',
    );
  });

  it('an import_pending outcome is counted import_pending', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'import_pending', importId: 'imp-1' } });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['import_pending']).toBe(1);
    expect(body['unknown_error']).toBe(0);
  });
});

/**
 * Drizzle keeps a template's literal fragments in `queryChunks`. A chunk can
 * itself be a nested `SQL`, so this RECURSES — a flat map would silently miss
 * a nested fragment and report it as absent.
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

/**
 * F119 PR-A — the send-time standing gate, as the cron sees it.
 *
 * A standing refusal is terminal and already recorded by the use case, so it
 * must land in `permanent_failed` — never `unknown_error`, whose counter PAGES
 * on-call as enum drift. A failed standing read is transient: `retryable`, and
 * the resolve-failed counter labelled `standing` so the runbook opens the
 * member-standing reads rather than the F3 page walk.
 */
describe('cron dispatch-scheduled — member standing at dispatch (F119 PR-A)', () => {
  it.each(['member_halted', 'member_not_in_good_standing'] as const)(
    'a %s refusal → permanent_failed, NOT unknown_error, and does not page',
    async (reason) => {
      oneRow();
      buildAudienceTickMock.mockResolvedValue(
        err({ kind: 'audience_import_failed', reason, importId: 'imp-1', observed: null, expected: null }),
      );

      const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
      const body = (await (await POST(makeRequest({ auth: 'Bearer test-cron-secret' }))).json()) as Record<string, number>;

      expect(body['permanent_failed']).toBe(1);
      expect(body['unknown_error']).toBe(0);
      expect(body['retryable']).toBe(0);
      expect(cronUnknownErrorCountSpy).not.toHaveBeenCalled();
    },
  );

  /**
   * R1 — a `suspended` member's due E-Blast is HELD: an ok answer that sent
   * nothing. Its own `held` bucket — never `succeeded` (nothing was
   * delivered), never `unknown_error` (which pages), and no resolve-failed
   * counter (nothing failed).
   */
  it('a HELD row → held:1, not succeeded, not unknown_error, no counter, no page', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'dispatch_held_member_suspended' } });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const body = (await (await POST(makeRequest({ auth: 'Bearer test-cron-secret' }))).json()) as Record<string, number>;

    expect(body['held']).toBe(1);
    expect(body['succeeded']).toBe(0);
    expect(body['import_pending']).toBe(0);
    expect(body['unknown_error']).toBe(0);
    expect(body['retryable']).toBe(0);
    expect(dispatchResolveFailedTotalSpy).not.toHaveBeenCalled();
    expect(cronUnknownErrorCountSpy).not.toHaveBeenCalled();
  });

  it('a terminal write that did not commit → retryable, counted under phase `terminal_write`', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue(
      err({ kind: 'dispatch.server_error', message: 'terminal_write_failed', phase: 'terminal_write' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const body = (await (await POST(makeRequest({ auth: 'Bearer test-cron-secret' }))).json()) as Record<string, number>;

    expect(body['retryable']).toBe(1);
    expect(body['permanent_failed']).toBe(0);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant', 'terminal_write');
  });

  it('a failed standing read → retryable, counted under phase `standing`', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue(
      err({ kind: 'dispatch.server_error', message: 'member_standing_halt_read_failed', errClass: 'Error', phase: 'standing' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const body = (await (await POST(makeRequest({ auth: 'Bearer test-cron-secret' }))).json()) as Record<string, number>;

    expect(body['retryable']).toBe(1);
    expect(body['permanent_failed']).toBe(0);
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant', 'standing');
  });

  // Spec 140 s4 (row 2) — the route builds the tick's deps once, from the tick
  // budget alone; the members-bridge memo is the maker's, pinned in
  // `broadcasts-deps-audience.test.ts`.
  it('the import deps are built once, from the tick budget alone, plus the brand chrome', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'import_pending', importId: 'imp-1' } });
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(buildDepsArgs).toEqual([['test-tenant', { tickStartedAt: expect.any(Number) }]]);
    const [importDeps] = buildAudienceTickMock.mock.calls[0] as [Record<string, unknown>];
    expect(importDeps).toMatchObject({ kind: 'build-deps-stub' });
    expect(importDeps['brandChrome']).toBeDefined();
  });
});

/**
 * Spec 140 s2a review round 3 (code-review #4, #5) — the route span carries
 * EVERY bucket the response summary counts, as `cron.<key>`: the attributes are
 * derived from the summary, so a new bucket cannot be left off the trace
 * (round 2 had to add a bucket by hand).
 */
describe('cron dispatch-scheduled — span attributes mirror the summary (spec 140 s2a)', () => {
  it('every summary bucket is a cron.<key> span attribute', async () => {
    oneRow();
    buildAudienceTickMock.mockResolvedValue(err({ kind: 'broadcast_not_found', broadcastId: BROADCAST_ID }));

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, unknown>;
    const buckets = Object.entries(body).filter(([, v]) => typeof v === 'number');
    // Positive control: the summary has its buckets, this one counted.
    expect(buckets.length).toBeGreaterThan(10);
    expect(body['concurrent_skip']).toBe(1);
    // Spec 140 s4 — the legacy leg's bucket is gone with it.
    expect(body).not.toHaveProperty('import_row_skipped');
    for (const [key, value] of buckets) {
      expect(spanAttributes.get(`cron.${key}`), `cron.${key}`).toBe(value);
    }
  });
});

/**
 * Spec 140 s2b — the route and the dispatch lease.
 *   row 13 (A7) — the due scan leaves out a row whose lease is live (a held row
 *            must not take a `LIMIT` slot, and a dead holder's row waits out
 *            its lease, then is reclaimed).
 *   DL9 — the tick gets `{ tickStartedAt }` (the route's entry instant), and a
 *            row deferred past the cutoff is its own bucket — never `succeeded`
 *            or `import_pending`, which an ok kind would otherwise fall into.
 */
describe('cron dispatch-scheduled — the dispatch lease (spec 140 s2b)', () => {
  const LEASE_EXCLUSION = '(dispatch_lease_token IS NULL OR dispatch_lease_expires_at < now())';
  const captureScan = (rows: unknown[] = []): unknown[] => {
    const executed: unknown[] = [];
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async (q: unknown) => {
          executed.push(q);
          return rows;
        },
      }),
    );
    return executed;
  };

  it('row 13 — the scan excludes a live lease', async () => {
    const executed = captureScan();
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const scanSql = sqlTextOf(executed[0]);
    // Positive control: the clauses the due scan always keeps.
    expect(scanSql).toContain("status = 'approved'");
    expect(scanSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(scanSql).toContain(LEASE_EXCLUSION);
  });

  it('DL9 — the tick receives the tick budget (the route entry instant)', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }]);
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'deferred_past_cutoff' } });
    const before = Date.now();
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const [importDeps] = buildAudienceTickMock.mock.calls[0] as [{ tickBudget?: { tickStartedAt: number } }];
    // Review round 3 (CR#7) — the budget carries the entry instant only.
    expect(importDeps.tickBudget).toEqual({ tickStartedAt: expect.any(Number) });
    expect(importDeps.tickBudget?.tickStartedAt).toBeGreaterThanOrEqual(before);
  });

  it('DL9 — a row deferred past the cutoff is counted deferred_past_cutoff, nothing else', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }]);
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'deferred_past_cutoff' } });
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['deferred_past_cutoff']).toBe(1);
    // Review round 2 (CR#5) — a deferred row is not processed.
    expect(body['processed']).toBe(0);
    expect(body['succeeded']).toBe(0);
    expect(body['import_pending']).toBe(0);
    expect(body['unknown_error']).toBe(0);
  });

  // Review round 1 (CR#6) — the tick budget is a REQUIRED maker parameter the
  // route passes (no `Date.now()` default in the maker, no second copy of
  // maxDuration): the maker hands it to the use case unchanged.
  it('the route passes its tick budget to the import deps maker', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }]);
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'import_pending', importId: 'imp-1' } });
    const before = Date.now();
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const budget = buildDepsArgs[0]?.[1] as { tickStartedAt: number } | undefined;
    expect(budget?.tickStartedAt).toBeGreaterThanOrEqual(before);
    const [importDeps] = buildAudienceTickMock.mock.calls[0] as [{ tickBudget?: unknown }];
    expect(importDeps.tickBudget).toBe(budget);
  });

  // Review round 1 (CR#7) — past the cutoff no later row can start either, so
  // the route stops at the first deferral and counts every row it left.
  it('DL9 — the route stops scanning rows after the first deferred_past_cutoff and counts the rest deferred', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }, { broadcast_id: 'row-2' }, { broadcast_id: 'row-3' }]);
    buildAudienceTickMock.mockResolvedValue({ ok: true, value: { kind: 'deferred_past_cutoff' } });
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(buildAudienceTickMock).toHaveBeenCalledTimes(1);
    expect(body['deferred_past_cutoff']).toBe(3);
    expect(body['processed']).toBe(0);
  });

  // Review round 2 (CR#5, spec L-d) — processed + deferred_past_cutoff = the rows reached.
  it('DL9 — one row runs and the rest defer: processed 1, deferred_past_cutoff 2', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }, { broadcast_id: 'row-2' }, { broadcast_id: 'row-3' }]);
    buildAudienceTickMock
      .mockResolvedValueOnce({ ok: true, value: { kind: 'sent' } })
      .mockResolvedValue({ ok: true, value: { kind: 'deferred_past_cutoff' } });
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(buildAudienceTickMock).toHaveBeenCalledTimes(2);
    expect(body['processed']).toBe(1);
    expect(body['succeeded']).toBe(1);
    expect(body['deferred_past_cutoff']).toBe(2);
  });

  // Review round 1 (CR#4) — a lease that expired on its own holder is a budget
  // breach: its own bucket (and so its own span attribute), a WARN line and
  // `broadcasts_dispatch_lease_expiring_total`; never concurrent_skip or unknown_error.
  it('a lease_expiring outcome has its own bucket and WARN', async () => {
    captureScan([{ broadcast_id: BROADCAST_ID }]);
    dispatchLeaseExpiringSpy.mockReset();
    buildAudienceTickMock.mockResolvedValue(err({ kind: 'lease_expiring', step: 'sendBroadcast' }));
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-scheduled/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const body = (await res.json()) as Record<string, number>;
    expect(body['lease_expiring']).toBe(1);
    expect(body['concurrent_skip']).toBe(0);
    expect(body['unknown_error']).toBe(0);
    expect(spanAttributes.get('cron.lease_expiring')).toBe(1);
    expect(dispatchLeaseExpiringSpy).toHaveBeenCalledWith('test-tenant');
    expect(cronUnknownErrorCountSpy).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { tenantId: 'test-tenant', broadcastId: BROADCAST_ID, step: 'sendBroadcast' },
      'cron.broadcasts.dispatch.lease_expiring',
    );
  });
});
