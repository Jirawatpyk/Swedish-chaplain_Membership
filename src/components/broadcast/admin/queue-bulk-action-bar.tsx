'use client';

/**
 * Task 5 (2026-08-01-broadcast-review-queue-pr2) — `QueueBulkActionBar`.
 *
 * Task 6 wires this in: `QueueWithBulk` owns `selectedIds` (mirrored from
 * `QueueTableClient`'s `onSelectionChange`) + a `clearNonce` counter, mounts
 * this bar as a SIBLING of the table, and the client's OLD sticky-top
 * `role="region"` bar + `handleBulkApprove` are deleted from
 * `queue-table-client.tsx` in the same change — this is now the only
 * bulk-action surface for the queue.
 *
 * Fixed-bottom `role="toolbar"` + measured-height `ResizeObserver` spacer,
 * mirroring `admin/members/_components/bulk-action-bar.tsx` (`:138-158` the
 * spacer effect, `:377-419` the bar shell + over-cap alert) and the
 * renewals `pipeline-bulk-action-bar.tsx`. Plain tab order — no
 * roving-tabindex, matching both precedents exactly.
 *
 * The bulk-approve fan-out (chunked `Promise.allSettled`, `BULK_CHUNK = 5`,
 * `{decision: 'send_now'}` per row) is MOVED from the sticky-top bar in
 * `queue-table-client.tsx:285-394` (`handleBulkApprove`), with one
 * unavoidable adaptation: this component receives a plain `selectedIds:
 * string[]` (per the Task 5 contract — "the bar should operate on the
 * selectedIds prop, not a table instance"), not a TanStack `Table` row
 * model. The original handler read `r.original.subject` off each selected
 * ROW to build a per-failure toast description ("Q3 Newsletter (409)") and
 * called `setRowSelection(...)` directly to keep failed rows selected for
 * retry. Neither is available here:
 *
 *   - No `subject` per id — the toast description listing failed subjects
 *     is DROPPED. The three-way `successAll` / `failureAll` / `partial`
 *     toast (with `{ok, fail}` counts) is kept verbatim; only the
 *     `.description` addendum is gone.
 *   - No `rowSelection` to mutate — selection ownership lives in the
 *     wrapper (Task 6) via the `selectedIds`/`onClear`/`onPartialFailure`
 *     props. On full success this calls `onClear()` (mirrors
 *     `setRowSelection({})`). On a TOTAL failure (nothing succeeded) it
 *     calls neither — the existing selection already equals the failed
 *     set, so there's nothing to reconcile, and the admin can retry
 *     without re-selecting. On a PARTIAL failure (CF-2, Task 5 review
 *     carry-forward) it calls `onPartialFailure(failedIds)` — see
 *     `queue-with-bulk.tsx`'s module docstring for why the wrapper's
 *     current handling of that is "clear everything" rather than "narrow
 *     to the failed ids" (the latter needs a prop surface beyond this
 *     task's contract and risks desyncing the toolbar from the table's
 *     actual checkboxes).
 *
 * `BulkProgressIndicator` (the members/renewals bars' in-flight indicator)
 * is intentionally NOT reused here: it requires `progressLabel` /
 * `progressMessage` / `elapsedSeconds` / `actions.<action>` keys in the
 * translation namespace it's given, and `admin.broadcasts.queue.bulk` (the
 * namespace Task 1 populated) carries none of them — only the six keys this
 * component actually consumes (`toolbarLabel`, `selectedCount`, `clear`,
 * `approveSelected`, `overCap`, `overCapHelper`) plus the three fan-out
 * toast keys (`successAll`, `failureAll`, `partial`). Adding a
 * progress-indicator key set was out of Task 1's scope; a plain
 * `disabled={executing}` on both buttons covers in-flight feedback for now.
 *
 * `overCap` does NOT disable the Approve button (unlike the members bar,
 * which refuses to act at all past the cap) — the Task 5 contract is
 * explicit: `cappedIds = selectedIds.slice(0, BULK_CAP)` and the button
 * "runs the fan-out over cappedIds", i.e. truncate-and-still-run rather
 * than block-until-split. The over-cap alert communicates the truncation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BULK_CAP } from '@/lib/members-bulk-constants';

const BULK_CHUNK = 5;

export interface QueueBulkActionBarProps {
  readonly selectedIds: string[];
  readonly onClear: () => void;
  readonly readOnly: boolean;
  /**
   * Task 6 CF-2 — called (instead of `onClear`) after a PARTIAL fan-out
   * failure (some approvals succeeded, some didn't), with the list of ids
   * that did NOT succeed. On a FULL failure (nothing succeeded) neither
   * this nor `onClear` is called — the existing selection already equals
   * the failed set, so there's nothing to reconcile. See
   * `queue-with-bulk.tsx`'s module docstring for how the caller currently
   * handles this (acceptable-minimum: clears the whole selection).
   */
  readonly onPartialFailure?: (failedIds: string[]) => void;
}

type Outcome =
  | { id: string; ok: true }
  | { id: string; ok: false; status: number; code: string | null };

export function QueueBulkActionBar({
  selectedIds,
  onClear,
  onPartialFailure,
  readOnly,
}: QueueBulkActionBarProps): React.JSX.Element | null {
  const t = useTranslations('admin.broadcasts.queue.bulk');
  const router = useRouter();
  const [executing, setExecuting] = useState(false);

  // Sticky-bar spacer — verbatim copy of `bulk-action-bar.tsx:138-158`.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(64);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    // Guard for jsdom/older browsers: without ResizeObserver the spacer
    // keeps its last measured value rather than collapsing to 0.
    if (typeof ResizeObserver === 'undefined') {
      setBarHeight(el.offsetHeight);
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      // Round up — a fractional height would leave a sub-pixel sliver of the
      // last row under the bar.
      setBarHeight(Math.ceil(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cappedIds = selectedIds.slice(0, BULK_CAP);
  const overCap = selectedIds.length > BULK_CAP;

  // IMP-1 (queue-table-client.tsx round-3) — chunked Promise.allSettled,
  // moved verbatim in spirit (see module docstring for what could not
  // carry over unchanged). Each chunk awaits before the next so we never
  // exceed BULK_CHUNK concurrent requests against the approve endpoint.
  const handleBulkApprove = useCallback(async () => {
    if (cappedIds.length === 0 || executing) return;
    setExecuting(true);
    try {
      const outcomes: Outcome[] = [];

      for (let i = 0; i < cappedIds.length; i += BULK_CHUNK) {
        const chunk = cappedIds.slice(i, i + BULK_CHUNK);
        const settled = await Promise.allSettled(
          chunk.map(async (id) => {
            const res = await fetch(`/api/admin/broadcasts/${id}/approve`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'send_now' }),
            });
            return { res, id };
          }),
        );
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            const { res, id } = result.value;
            if (res.ok) {
              outcomes.push({ id, ok: true });
            } else {
              const body = (await res.json().catch(() => null)) as
                | { error?: { code?: string } }
                | null;
              outcomes.push({
                id,
                ok: false,
                status: res.status,
                code: body?.error?.code ?? null,
              });
            }
          } else {
            const idx = settled.indexOf(result);
            const id = chunk[idx];
            if (id) outcomes.push({ id, ok: false, status: 0, code: null });
          }
        }
      }

      const failures = outcomes.filter(
        (o): o is Extract<Outcome, { ok: false }> => !o.ok,
      );
      const succeeded = outcomes.length - failures.length;

      if (failures.length === 0) {
        toast.success(t('successAll'));
        // Mirrors `setRowSelection({})` in the moved handler — selection
        // ownership lives in the wrapper (Task 6), so clearing it means
        // asking the caller to.
        onClear();
      } else if (succeeded === 0) {
        toast.error(t('failureAll'));
        // Keep the bar mounted (selection unchanged) so the admin can retry
        // without re-selecting.
      } else {
        toast.warning(t('partial', { ok: succeeded, fail: failures.length }));
        // Task 6 CF-2 — tell the caller which ids failed so it can decide
        // what to do with the selection (see queue-with-bulk.tsx's module
        // docstring for the caller's current acceptable-minimum handling).
        onPartialFailure?.(failures.map((f) => f.id));
      }
      router.refresh();
    } finally {
      setExecuting(false);
    }
  }, [cappedIds, executing, onClear, onPartialFailure, router, t]);

  if (readOnly || selectedIds.length === 0) return null;

  return (
    <>
      <div
        ref={barRef}
        // `pb-[env(safe-area-inset-bottom)]` keeps the action row clear of the
        // iOS home indicator on a notched device — same as the members bar.
        className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm shadow-lg"
        style={{ scrollMarginBottom: '80px' }}
        role="toolbar"
        aria-label={t('toolbarLabel')}
      >
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium" aria-live="polite">
              {t('selectedCount', { count: selectedIds.length })}
            </span>
            {overCap && (
              <div className="flex flex-col gap-0.5" role="alert">
                {/* CF-4 (Task 5 review carry-forward) — bumped from `text-xs`
                    to `text-sm` so the pre-send truncate-and-run warning
                    can't be missed. PR2 keeps truncate-and-run (the button
                    still runs the fan-out over `cappedIds`); PR3's confirm
                    dialog is the hard guard. */}
                <span className="text-sm font-medium text-destructive">
                  {t('overCap', { max: BULK_CAP })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('overCapHelper', { count: selectedIds.length, max: BULK_CAP })}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={executing}
              className="min-h-11"
            >
              <XIcon className="mr-1 h-4 w-4" />
              {t('clear')}
            </Button>
            <Button
              size="sm"
              disabled={executing}
              onClick={handleBulkApprove}
              className="min-h-11 whitespace-nowrap"
            >
              {t('approveSelected')}
            </Button>
          </div>
        </div>
      </div>

      {/* Spacer — tracks the bar's MEASURED height (see barHeight above), so a
          wrapped multi-row bar can never cover the last table row or the
          pagination control. */}
      <div data-testid="queue-bulk-spacer" style={{ height: barHeight }} aria-hidden="true" />
    </>
  );
}
