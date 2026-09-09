// @vitest-environment node
/**
 * 108 Phase 9 FINAL review — **the `has_more` → `complete` mapping had no test
 * at any layer, and it was written in the fail-OPEN direction.**
 *
 * All six reviewers in the final round independently reported the same line
 * (`resend-broadcasts-gateway.ts:447`):
 *
 *     complete: result.data?.has_more !== true
 *
 * while its own docblock 23 lines above said *"Narrowed with `=== true` so a
 * missing field reads as 'not complete', which is the safe direction: an absent
 * signal must not be reported as a verified-complete count."* `undefined !== true`
 * is `true`, so an absent signal WAS reported as a verified-complete count.
 *
 * Why nothing caught it: all nine `getAudienceContactCount` doubles in the repo
 * inject `complete` directly on the Application port, so no test could observe
 * `has_more` at all — `grep -rn has_more tests/` returned only comments. The
 * shared contract fake (`tests/support/broadcasts/resend-contract-fake.ts`)
 * models the PRE-fix response shape and would have certified `complete` on a
 * response that never carried the signal, so it cannot close this either.
 *
 * **This file therefore asserts the mapping against the WIRE**, the way
 * `resend-send-broadcast.test.ts` asserts the idempotency header — a test that
 * stubbed the port would have passed throughout the bug.
 *
 * Runs under `node` and turns the repo's global fake timers off for the same
 * reason as its two siblings: this is Node-side HTTP code and `withRetry` uses a
 * real `setTimeout`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const AUDIENCE_ID = 'aud_11111111-2222-4333-8444-555555555555';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubListOnce(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(status, body)),
  );
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAudienceContactCount — has_more decides `complete` (FINAL round, 6/6 reviewers)', () => {
  it('has_more: true → complete: false (Resend held rows back)', async () => {
    stubListOnce(200, { object: 'list', data: [{ id: 'c1' }], has_more: true });

    const outcome = await resendBroadcastsGateway.getAudienceContactCount(AUDIENCE_ID);

    expect(outcome).toEqual({ kind: 'present', count: 1, complete: false });
  });

  it('has_more: false → complete: true (the ONLY input that verifies a count)', async () => {
    stubListOnce(200, { object: 'list', data: [{ id: 'c1' }, { id: 'c2' }], has_more: false });

    const outcome = await resendBroadcastsGateway.getAudienceContactCount(AUDIENCE_ID);

    expect(outcome).toEqual({ kind: 'present', count: 2, complete: true });
  });

  /**
   * THE FINDING. An older or changed API shape omits the field entirely. The
   * count is then a lower bound, and both callers derive their fail-safe from
   * this flag — `build-audience-tick.ts` (`complete || count > resolved`) and
   * `dispatch-scheduled-broadcast.ts` (`outcome.complete || outcome.count >
   * expected`). Reporting `true` here makes a truncated read authoritative: on
   * the LIVE leg that files a false `broadcast_resend_audience_drift` row into an
   * append-only table and pages § 22.3; on the import leg it reports a
   * carried-over unsubscribed contact as a verified-clean audience.
   */
  it('has_more ABSENT → complete: false — an absent signal is not verification', async () => {
    stubListOnce(200, { object: 'list', data: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });

    const outcome = await resendBroadcastsGateway.getAudienceContactCount(AUDIENCE_ID);

    expect(outcome).toEqual({ kind: 'present', count: 3, complete: false });
  });

  /**
   * The second, worse arm of the same defect. `ResendSdkResponse<T>.data` is
   * `T | null | undefined`, and the adapter's own `?.` + `?? 0` acknowledge it.
   * With `!== true` a payload-less success became `{count: 0, complete: true}` —
   * a confidently-verified ZERO manufactured from no data at all, which on the
   * live leg reads as "the audience is empty, nobody was mailed".
   */
  it('a payload-less 200 is never a verified zero', async () => {
    stubListOnce(200, {});

    const outcome = await resendBroadcastsGateway.getAudienceContactCount(AUDIENCE_ID);

    expect(outcome).toEqual({ kind: 'present', count: 0, complete: false });
  });

  /**
   * MEASURED 2026-09-10, read-only probe against the live account:
   *
   *   GET /audiences/00000000-0000-4000-8000-000000000000/contacts
   *   → HTTP 200  {"object":"list","has_more":false,"data":[]}
   *
   * A NONEXISTENT audience is not a 404 on this endpoint — it is an empty list,
   * and `has_more` is present and `false`. (The sibling `GET /audiences/{id}`
   * *does* 404, with `{"statusCode":404,"message":"Audience not found",
   * "name":"not_found"}` — so `classifyResendError`'s `err?.statusCode` is read
   * off a field that really is on the wire, even though `resend@4.8.0` declares
   * `ErrorResponse` as only `{message, name}`.)
   *
   * Two consequences, both pinned here because both were invisible before this
   * file existed:
   *
   *  1. `getAudienceContactCount` can NEVER answer `not_found` via the list
   *     endpoint. The arm is real code with no reachable input, so the callers'
   *     `not_found` handling is driven by nothing.
   *  2. A DELETED audience is indistinguishable from an empty one, and returns
   *     the one shape that makes `complete` authoritative. So the honest answer
   *     from this adapter is a verified-complete zero, and the "an audience that
   *     reports 0 when we just pushed N is far more likely GONE than empty"
   *     judgement belongs to the caller, not here. `dispatch-scheduled-broadcast`
   *     is where that lands.
   */
  it('a deleted audience is a verified-complete ZERO here, not not_found (measured)', async () => {
    stubListOnce(200, { object: 'list', has_more: false, data: [] });

    const outcome = await resendBroadcastsGateway.getAudienceContactCount(AUDIENCE_ID);

    expect(outcome).toEqual({ kind: 'present', count: 0, complete: true });
  });
});
