/**
 * Task 5 (2026-08-02-broadcast-review-queue-pr3) — `cancelApprovedBroadcasts`.
 *
 * The 60s send-now "Undo" toast (wired into the bulk bar + single approve
 * dialog) fans this helper out over the EXISTING
 * `POST /api/admin/broadcasts/{id}/cancel` endpoint — there is no dedicated
 * undo endpoint. The endpoint's admin-cancel body REQUIRES a non-empty
 * `cancellationReason` (1..500 chars, `AdminCancelBodySchema` in
 * `src/app/api/admin/broadcasts/[id]/cancel/route.ts`) — an empty reason
 * 400s, so this helper always forwards the caller-supplied canned reason
 * (the i18n key `admin.broadcasts.queue.bulk.undo.reason`) verbatim.
 *
 * Classification (mirrors `cancel-broadcast-dialog.tsx`'s 409 code split,
 * simplified to 3 buckets since there's no dialog UI to keep open here):
 *   - `res.ok` (200)                                    → cancelled
 *   - 409 with `error.code === 'broadcast_cancel_too_late'` → tooLate
 *     (the cron already dispatched — a race, not a hard error)
 *   - anything else (other 409 codes, 404/403/400/5xx, a rejected
 *     `res.json()`, or a rejected `fetch()` itself)      → failed
 *
 * This helper must NEVER throw — it's invoked from a toast action's
 * `onClick`, where an uncaught rejection would surface as an unhandled
 * promise rejection with no user-visible feedback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelApprovedBroadcasts } from '@/components/broadcast/admin/send-now-undo';

describe('cancelApprovedBroadcasts', () => {
  // Shared test setup (`tests/setup.ts`) installs fake timers globally —
  // the chunking test below uses a real `setTimeout(0)` to simulate
  // overlapping in-flight requests, which would otherwise spin forever
  // under fake timers. Precedent: `queue-bulk-action-bar.test.tsx`.
  beforeEach(() => {
    vi.useRealTimers();
  });


  it('classifies 200 as cancelled, 409 too_late as tooLate, others as failed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'broadcast_cancel_too_late' } }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'internal_error' } }), {
          status: 500,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const r = await cancelApprovedBroadcasts(['a', 'b', 'c'], 'reason');

    expect(r).toEqual({ cancelled: 1, tooLate: 1, failed: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/broadcasts/a/cancel');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      cancellationReason: 'reason',
    }); // non-empty reason REQUIRED — the endpoint 400s on an empty string
    vi.unstubAllGlobals();
  });

  it('classifies a 409 with a DIFFERENT code (e.g. concurrent-action-blocked) as failed, not tooLate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: 'broadcast_concurrent_action_blocked' },
          }),
          { status: 409 },
        ),
      ),
    );

    const r = await cancelApprovedBroadcasts(['a'], 'reason');

    expect(r).toEqual({ cancelled: 0, tooLate: 0, failed: 1 });
    vi.unstubAllGlobals();
  });

  it('never throws — a rejected fetch() and an unparsable error body both count as failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(
          new Response('not json', { status: 500 }),
        ),
    );

    const r = await cancelApprovedBroadcasts(['a', 'b'], 'reason');

    expect(r).toEqual({ cancelled: 0, tooLate: 0, failed: 2 });
    vi.unstubAllGlobals();
  });

  it('chunks the fan-out by 5 — a 12-id batch never has more than 5 in-flight requests at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight--;
        return new Response(JSON.stringify({ status: 'cancelled' }), {
          status: 200,
        });
      }),
    );

    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const r = await cancelApprovedBroadcasts(ids, 'reason');

    expect(r).toEqual({ cancelled: 12, tooLate: 0, failed: 0 });
    expect(maxInFlight).toBeLessThanOrEqual(5);
    vi.unstubAllGlobals();
  });

  it('returns all-zero tallies for an empty id list without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const r = await cancelApprovedBroadcasts([], 'reason');

    expect(r).toEqual({ cancelled: 0, tooLate: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
