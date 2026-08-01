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
 *
 * Task 4 (2026-08-02-broadcast-review-queue-pr3) — the "Approve selected"
 * button no longer fans out directly. It opens `BulkApproveConfirmDialog`
 * (Task 3), which is the ONLY caller of `handleBulkApprove` now that the
 * handler takes a `BulkApproveDecision` param. This is the load-bearing
 * tamper-safety seam: `BulkApproveDecision` structurally carries only
 * `type` (+ `scheduledFor` for schedule) — never a recipient count — so the
 * per-row request body built from it cannot include `totalRecipients`
 * even by accident. The dialog itself never fetches; it is purely a
 * confirmation gate in front of this component's existing fan-out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BULK_CAP } from '@/lib/members-bulk-constants';
import {
  BulkApproveConfirmDialog,
  type BulkApproveDecision,
} from '@/components/broadcast/admin/bulk-approve-confirm-dialog';
import { cancelApprovedBroadcasts } from '@/components/broadcast/admin/send-now-undo';

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
  /**
   * Task 2 (2026-08-02-broadcast-review-queue-pr3) — per-row recipient
   * counts, keyed by broadcast id, so the bar can derive a total-recipients
   * figure for the upcoming confirm dialog (Task 4). One row per entry in
   * `EnrichedQueueRow` (`queue-table-client.tsx`); `queue-with-bulk.tsx`
   * threads the whole `rows` prop through unchanged.
   */
  readonly recipientByIdRows: ReadonlyArray<{
    readonly broadcastId: string;
    readonly recipientCount: number;
  }>;
}

type Outcome =
  | { id: string; ok: true }
  | { id: string; ok: false; status: number; code: string | null };

export function QueueBulkActionBar({
  selectedIds,
  onClear,
  onPartialFailure,
  readOnly,
  recipientByIdRows,
}: QueueBulkActionBarProps): React.JSX.Element | null {
  const t = useTranslations('admin.broadcasts.queue.bulk');
  const tUndo = useTranslations('admin.broadcasts.queue.bulk.undo');
  const router = useRouter();
  const [executing, setExecuting] = useState(false);

  // Task 4 — the confirm dialog's own open state + the "Approve selected"
  // trigger ref (F7-A11Y-1 finalFocus target, per `review-actions.tsx`'s
  // approve/reject-trigger precedent).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const approveBtnRef = useRef<HTMLButtonElement | null>(null);

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

  // Task 5 review carry-forward (Task 4) — memoized on `selectedIds` so the
  // `totalRecipients` memo below (keyed on this array's REFERENCE) actually
  // holds across renders. Before this fix `cappedIds` was a plain
  // `selectedIds.slice(...)` re-evaluated every render, producing a fresh
  // array reference each time — `useMemo([recipientByIdRows, cappedIds])`
  // was therefore a no-op that recomputed on every render regardless of
  // whether either input had actually changed (e.g. a sibling state update
  // from the confirm dialog's own schedule input re-rendering this bar).
  // Pure perf fix — no behaviour change.
  const cappedIds = useMemo(
    () => selectedIds.slice(0, BULK_CAP),
    [selectedIds],
  );
  const overCap = selectedIds.length > BULK_CAP;

  // Task 2 (2026-08-02-broadcast-review-queue-pr3) — sum over `cappedIds`
  // (the actually-actioned set), never raw `selectedIds`: the total must
  // match what the fan-out below will actually approve, not what's merely
  // checked past the cap.
  //
  // Task 4 — memoized: consumed on every render by the confirm dialog
  // below, so without this the Map + reduce would be rebuilt on every
  // keystroke inside that dialog's own schedule input (a sibling state
  // update in this same component tree re-renders the bar too).
  const totalRecipients = useMemo(() => {
    const recipientById = new Map(
      recipientByIdRows.map((r) => [r.broadcastId, r.recipientCount]),
    );
    return cappedIds.reduce((sum, id) => sum + (recipientById.get(id) ?? 0), 0);
  }, [recipientByIdRows, cappedIds]);

  // IMP-1 (queue-table-client.tsx round-3) — chunked Promise.allSettled,
  // moved verbatim in spirit (see module docstring for what could not
  // carry over unchanged). Each chunk awaits before the next so we never
  // exceed BULK_CHUNK concurrent requests against the approve endpoint.
  //
  // Task 4 — parameterized on the confirm dialog's `BulkApproveDecision`.
  // `rowBody` is built ONLY from `decision`'s own fields — `decision` has
  // no `totalRecipients`/recipient field to leak, so this is the
  // tamper-safety guarantee made structural rather than just reviewed-by-eye.
  const handleBulkApprove = useCallback(async (decision: BulkApproveDecision) => {
    if (cappedIds.length === 0 || executing) return;
    setExecuting(true);
    try {
      const rowBody =
        decision.type === 'send_now'
          ? { decision: 'send_now' as const }
          : { decision: 'schedule' as const, scheduledFor: decision.scheduledFor };
      const outcomes: Outcome[] = [];

      for (let i = 0; i < cappedIds.length; i += BULK_CHUNK) {
        const chunk = cappedIds.slice(i, i + BULK_CHUNK);
        const settled = await Promise.allSettled(
          chunk.map(async (id) => {
            const res = await fetch(`/api/admin/broadcasts/${id}/approve`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rowBody),
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

      // Task 5 (2026-08-02-broadcast-review-queue-pr3) — 60s send-now
      // "Undo". Shown IN ADDITION to the successAll/partial/failureAll
      // toast above (that one reports the approve outcome; this one is
      // the actionable escape hatch for the ≤60s window before the
      // dispatch cron picks the broadcast up). Schedule decisions get NO
      // Undo toast — an already-scheduled broadcast is cancellable via
      // the normal per-row action, so there's no "oops, sent now" race to
      // rescue.
      if (decision.type === 'send_now' && succeeded > 0) {
        const approvedIds = outcomes
          .filter((o): o is Extract<Outcome, { ok: true }> => o.ok)
          .map((o) => o.id);
        toast(tUndo('sendingSendNow', { count: approvedIds.length }), {
          duration: 60_000,
          action: {
            label: tUndo('action'),
            onClick: async () => {
              const r = await cancelApprovedBroadcasts(
                approvedIds,
                tUndo('reason'),
              );
              if (r.cancelled > 0) {
                toast.success(tUndo('success', { count: r.cancelled }));
              }
              if (r.tooLate > 0) {
                toast.warning(tUndo('tooLate', { count: r.tooLate }));
              }
              if (r.failed > 0) {
                toast.error(tUndo('failed', { count: r.failed }));
              }
              router.refresh();
            },
          },
        });
      }

      router.refresh();
    } finally {
      setExecuting(false);
    }
  }, [cappedIds, executing, onClear, onPartialFailure, router, t, tUndo]);

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
            {/* No `aria-live` here — the permanent `role="status"` announcer in
                `queue-table-client.tsx` (`selectionAnnouncement`) is the sole
                live region for this count. Duplicating `aria-live` on this
                visible span made screen readers announce every count change
                TWICE (I-1, PR2 whole-branch review). */}
            <span className="text-sm font-medium">
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
              ref={approveBtnRef}
              size="sm"
              disabled={executing}
              onClick={() => setConfirmOpen(true)}
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

      <BulkApproveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        broadcastCount={cappedIds.length}
        selectedCount={selectedIds.length}
        cap={BULK_CAP}
        totalRecipients={totalRecipients}
        onConfirm={(d) => handleBulkApprove(d)}
        triggerRef={approveBtnRef}
      />
    </>
  );
}
