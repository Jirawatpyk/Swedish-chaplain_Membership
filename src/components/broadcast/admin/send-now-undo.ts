/**
 * Task 5 (2026-08-02-broadcast-review-queue-pr3) — 60s send-now "Undo".
 *
 * There is no dedicated undo endpoint: Undo is a thin client-side escape
 * hatch over the EXISTING `POST /api/admin/broadcasts/{id}/cancel` route,
 * exercised within the ≤60s window before the dispatch cron picks the
 * broadcast up. That route's admin-cancel body schema (`AdminCancelBodySchema`
 * in `src/app/api/admin/broadcasts/[id]/cancel/route.ts`) REQUIRES a
 * non-empty `cancellationReason` (1..500 chars) — an empty reason 400s — so
 * every call here forwards the caller-supplied canned reason (the i18n key
 * `admin.broadcasts.queue.bulk.undo.reason`) verbatim.
 *
 * Fan-out mirrors `queue-bulk-action-bar.tsx`'s `BULK_CHUNK = 5` /
 * `Promise.allSettled` bulk-approve pattern: each chunk awaits before the
 * next so we never exceed 5 concurrent requests against the cancel
 * endpoint.
 *
 * Classification — 3 buckets, mirroring `cancel-broadcast-dialog.tsx`'s
 * 409-code split but simplified (there is no dialog UI to keep open here,
 * just a tally to report back through follow-up toasts):
 *   - `res.ok` (200)                                        → cancelled
 *   - 409 with `error.code === 'broadcast_cancel_too_late'` → tooLate
 *     (the cron already dispatched before Undo landed — a race, not a
 *     hard error)
 *   - anything else (other 409 codes, 404/403/400/5xx, an unparsable
 *     error body, or a rejected `fetch()` itself)            → failed
 *
 * NEVER throws: this is invoked from a `sonner` toast action's `onClick`,
 * where an uncaught rejection would surface as an unhandled promise
 * rejection with no user-visible feedback.
 */

const CANCEL_CHUNK = 5;

export interface UndoResult {
  readonly cancelled: number;
  readonly tooLate: number;
  readonly failed: number;
}

type Classification = 'cancelled' | 'tooLate' | 'failed';

async function cancelOne(
  id: string,
  cancellationReason: string,
): Promise<Classification> {
  try {
    const res = await fetch(`/api/admin/broadcasts/${id}/cancel`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancellationReason }),
    });
    if (res.ok) return 'cancelled';
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string } }
      | null;
    return body?.error?.code === 'broadcast_cancel_too_late'
      ? 'tooLate'
      : 'failed';
  } catch {
    return 'failed';
  }
}

/** Fan-out POST /cancel per approved id with a canned reason. Never throws. */
export async function cancelApprovedBroadcasts(
  ids: readonly string[],
  cancellationReason: string,
): Promise<UndoResult> {
  const tally = { cancelled: 0, tooLate: 0, failed: 0 };

  for (let i = 0; i < ids.length; i += CANCEL_CHUNK) {
    const chunk = ids.slice(i, i + CANCEL_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map((id) => cancelOne(id, cancellationReason)),
    );
    for (const result of settled) {
      // `cancelOne` never rejects (its own try/catch classifies as
      // 'failed'), but Promise.allSettled's type still allows a
      // 'rejected' branch — treat it the same way defensively so this
      // function's own NEVER-throws contract holds even if `cancelOne`
      // is ever changed to let something through.
      const classification: Classification =
        result.status === 'fulfilled' ? result.value : 'failed';
      tally[classification]++;
    }
  }

  return tally;
}
