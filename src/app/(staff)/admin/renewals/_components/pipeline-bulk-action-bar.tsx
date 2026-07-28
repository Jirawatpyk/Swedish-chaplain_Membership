'use client';

/**
 * 059-membership-suspension Task 11 — `PipelineBulkActionBar`.
 *
 * Sticky-bottom bulk toolbar for the renewals pipeline (US3), mirroring
 * `admin/members/_components/bulk-action-bar.tsx`'s shape: `role="toolbar"`,
 * a measured-height spacer (`ResizeObserver`), the shared
 * `useDialogFinalFocus`/`lastTriggerRef`/`closedViaSuccessRef` focus-return
 * chain (reused verbatim from `@/components/broadcast/reason-confirmation-
 * dialog`), `BulkProgressIndicator`, and the `BULK_CAP` (100) guard.
 *
 * Two actions, both fanning out over the EXISTING per-cycle routes (no new
 * settlement path — Constitution Principle IV):
 *   - **Send reminder** — `POST …/[cycleId]/send-reminder-now`, over the
 *     WHOLE selection (no previewable restriction).
 *   - **Mark paid** — `POST …/[cycleId]/mark-paid-offline`, over ONLY the
 *     previewable subset `BulkMarkPaidConfirmDialog` hands back (Decision 3).
 *
 * The Task 11 brief's own `fanOut` sketch (`res.ok ? ok : 409/422 ? skipped
 * : failed`) is TOO COARSE and is SUPERSEDED by the financial-integrity
 * review's Decisions — the real route bodies must be parsed:
 *
 *   - `send-reminder-now` — a `200` does NOT mean success: the body carries
 *     `{ outcome: { kind } }` where `kind` is `sent`/`task_created` (ok),
 *     `skipped` (skipped), or `failed_transient`/`failed_permanent`
 *     (FAILED, despite the 200 status — the "200-trap"). `409 already_sent`
 *     is a benign skip (idempotent replay). `429 rate_limited` is its OWN
 *     bucket — the route rate-limits 30/5min per (tenant, admin) and
 *     `BULK_CAP` is 100, so a bulk of >30 WILL hit this mid-batch; it is
 *     surfaced, never auto-retried.
 *   - `mark-paid-offline` — `409` is used for TWO semantically different
 *     things the body `error.code` must disambiguate: a benign not-payable
 *     state (`cycle_not_payable` / `member_terminated`, no money moved) vs
 *     an ORPHAN (`f4_orphan_invoice` / `membership_bill_already_exists` — a
 *     §87 document number is already burned; retrying would MINT A
 *     DUPLICATE). Orphans get their own bucket, kept visible, never
 *     auto-retried. `422`/`404`/`502`/`500`/a network throw all land in
 *     `failed`.
 *
 * Decision 5 (continue-on-error, no auto-retry, failed/skipped rows kept
 * VISIBLE — "a bare count is not enough on a money screen") is why the
 * outer sticky container keeps rendering a `BulkRunResultsPanel` with
 * company names, bucketed, even after the run clears the live selection
 * (`onClear()` always fires — see `reportOutcome` below — and `router.
 * refresh()` always resets `PipelineWithBulk`'s selection on the next
 * server render regardless of what this component does, so the ONLY way
 * to keep a failed/skipped row's identity visible is this component's OWN
 * `lastRunResult` state, independent of the live `selectedCycleIds` prop).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BanknoteIcon, BellIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { BulkProgressIndicator } from '../../members/_components/bulk-progress-indicator';
import { BULK_CAP } from '@/lib/members-bulk-constants';
import {
  BulkMarkPaidConfirmDialog,
  type BulkMarkPaidBatchEntry,
  type MarkPaidBatchBody,
} from './bulk-mark-paid-confirm-dialog';

type BulkOutcomeBucket = 'ok' | 'skipped' | 'failed' | 'orphan' | 'rateLimited';
type BulkAction = 'sendReminder' | 'markPaid';

interface BulkOutcomeItem {
  readonly cycleId: string;
  readonly companyName: string;
  readonly bucket: BulkOutcomeBucket;
}

interface RunResult {
  readonly action: BulkAction;
  readonly items: readonly BulkOutcomeItem[];
}

type BucketGroups = Record<BulkOutcomeBucket, BulkOutcomeItem[]>;

function groupByBucket(items: readonly BulkOutcomeItem[]): BucketGroups {
  const groups: BucketGroups = { ok: [], skipped: [], failed: [], orphan: [], rateLimited: [] };
  for (const item of items) groups[item.bucket].push(item);
  return groups;
}

/**
 * `send-reminder-now`'s outcome → bucket mapping. The 200-trap: a `200`
 * response is only `ok` when `outcome.kind` is `sent`/`task_created` — a
 * `failed_transient`/`failed_permanent` kind arrives with the SAME HTTP
 * status and must be read from the body, not `res.ok`.
 */
function classifySendReminderOutcome(res: Response, body: unknown): BulkOutcomeBucket {
  if (res.status === 429) return 'rateLimited';
  if (res.status === 409) return 'skipped'; // already_sent — idempotent replay.
  if (res.ok) {
    const kind = (body as { outcome?: { kind?: string } } | null)?.outcome?.kind;
    if (kind === 'sent' || kind === 'task_created') return 'ok';
    if (kind === 'skipped') return 'skipped';
    // failed_transient / failed_permanent / an unrecognised kind — all
    // FAILED despite the 200 status (the 200-trap this task exists to fix).
    return 'failed';
  }
  // 404 / 400 / 500.
  return 'failed';
}

/**
 * `mark-paid-offline`'s outcome → bucket mapping. Both `f4_orphan_invoice`
 * and `membership_bill_already_exists` are 409s that must NEVER be
 * retried (a §87 document number is already burned) — kept in their own
 * `orphan` bucket, distinct from the BENIGN 409s (`cycle_not_payable` /
 * `member_terminated`, no money moved) that land in `skipped`.
 */
function classifyMarkPaidOutcome(res: Response, body: unknown): BulkOutcomeBucket {
  if (res.ok) return 'ok';
  const code = (body as { error?: { code?: string } } | null)?.error?.code;
  if (res.status === 409) {
    if (code === 'f4_orphan_invoice' || code === 'membership_bill_already_exists') {
      return 'orphan';
    }
    return 'skipped';
  }
  // 422 (+404) permanent/actionable and 502/500 transient both surface as
  // `failed` — Decision 5 only requires the orphan bucket be kept distinct
  // from these, not a further permanent/transient split.
  return 'failed';
}

/**
 * Sequential (not `Promise.all`) fan-out over an existing per-cycle route.
 * Mark-paid mints an invoice + holds a per-(tenant, invoice) advisory lock
 * per row; serialising bounds DB/lock contention and keeps
 * `BulkProgressIndicator`'s elapsed-time feedback meaningful. Continue-
 * on-error (Decision 5): one entry throwing/failing never stops the rest.
 */
async function runFanOut(
  entries: ReadonlyArray<{ cycleId: string; companyName: string }>,
  request: (cycleId: string) => Promise<Response>,
  classify: (res: Response, body: unknown) => BulkOutcomeBucket,
): Promise<BulkOutcomeItem[]> {
  const items: BulkOutcomeItem[] = [];
  for (const entry of entries) {
    try {
      const res = await request(entry.cycleId);
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      items.push({
        cycleId: entry.cycleId,
        companyName: entry.companyName,
        bucket: classify(res, body),
      });
    } catch {
      items.push({ cycleId: entry.cycleId, companyName: entry.companyName, bucket: 'failed' });
    }
  }
  return items;
}

export interface PipelineBulkActionBarProps {
  readonly selectedCycleIds: string[];
  readonly selectedCompanyNames: string[];
  readonly totalMatching: number;
  readonly onClear: () => void;
}

export function PipelineBulkActionBar({
  selectedCycleIds,
  selectedCompanyNames,
  totalMatching,
  onClear,
}: PipelineBulkActionBarProps) {
  const t = useTranslations('admin.renewals.bulk');
  const router = useRouter();

  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [markPaidDialogOpen, setMarkPaidDialogOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ action: BulkAction; total: number } | null>(null);
  // Decision 5 — persists across a run so failed/skipped/orphan company
  // names stay visible even after `onClear()` empties `selectedCycleIds`
  // and `router.refresh()` reloads the table. Independent of the live
  // selection on purpose (see the module docstring).
  const [lastRunResult, setLastRunResult] = useState<RunResult | null>(null);

  const count = selectedCycleIds.length;
  // Defensive only — like the members bar, currently unreachable in
  // practice (Task 10 selection is page-only, well under BULK_CAP), but
  // the server-side route + BULK_CAP=100 settlement-preview cap are the
  // real enforcement regardless of this client guard.
  const overCap = count > BULK_CAP;
  const hasSelection = count > 0;
  const visible = hasSelection || lastRunResult !== null;

  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(lastTriggerRef, undefined, closedViaSuccessRef);

  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(64);

  // Re-observes on every hidden↔visible transition (not `[]` like the
  // members bar) — this bar can become visible from a `count===0` mount
  // (no selection yet) OR from a `lastRunResult` alone (selection already
  // cleared), and a `[]`-deps effect would only ever attach if the FIRST
  // render happened to be visible, missing every later transition.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setBarHeight(el.offsetHeight);
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      setBarHeight(Math.ceil(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  const companyNameOf = useCallback(
    (cycleId: string): string => {
      const idx = selectedCycleIds.indexOf(cycleId);
      return idx >= 0 ? (selectedCompanyNames[idx] ?? cycleId) : cycleId;
    },
    [selectedCycleIds, selectedCompanyNames],
  );

  const reportOutcome = useCallback(
    (action: BulkAction, items: BulkOutcomeItem[]) => {
      const buckets = groupByBucket(items);
      const parts: string[] = [];
      if (action === 'sendReminder') {
        if (buckets.ok.length) parts.push(t('reminderSent', { sent: buckets.ok.length }));
        if (buckets.skipped.length)
          parts.push(t('reminderSkipped', { skipped: buckets.skipped.length }));
        if (buckets.rateLimited.length)
          parts.push(t('reminderRateLimited', { count: buckets.rateLimited.length }));
        if (buckets.failed.length)
          parts.push(t('reminderFailed', { failed: buckets.failed.length }));
      } else {
        if (buckets.ok.length) parts.push(t('markPaidSucceeded', { count: buckets.ok.length }));
        if (buckets.skipped.length)
          parts.push(t('markPaidSkipped', { count: buckets.skipped.length }));
        if (buckets.orphan.length)
          parts.push(t('markPaidOrphan', { count: buckets.orphan.length }));
        if (buckets.failed.length)
          parts.push(t('markPaidFailed', { count: buckets.failed.length }));
      }
      const message = parts.join(' · ');
      const hasError = buckets.failed.length > 0 || buckets.orphan.length > 0;
      if (hasError) toast.error(message);
      else if (buckets.ok.length > 0) toast.success(message);
      else toast.info(message);

      const hasIssues =
        buckets.skipped.length +
          buckets.failed.length +
          buckets.orphan.length +
          buckets.rateLimited.length >
        0;
      setLastRunResult(hasIssues ? { action, items } : null);

      // Raise BEFORE onClear(): mirrors the members bar — onClear() is what
      // (eventually, via the parent) empties the live selection, and Base
      // UI reads finalFocus when the dialog closes just after this resolves.
      closedViaSuccessRef.current = true;
      onClear();
      router.refresh();
    },
    [onClear, router, t],
  );

  const handleSendReminders = useCallback(async () => {
    const entries = selectedCycleIds.map((id) => ({ cycleId: id, companyName: companyNameOf(id) }));
    setExecuting(true);
    setProgress({ action: 'sendReminder', total: entries.length });
    try {
      const items = await runFanOut(
        entries,
        (cycleId) =>
          fetch(`/api/admin/renewals/${encodeURIComponent(cycleId)}/send-reminder-now`, {
            method: 'POST',
          }),
        classifySendReminderOutcome,
      );
      reportOutcome('sendReminder', items);
    } finally {
      setExecuting(false);
      setProgress(null);
    }
  }, [selectedCycleIds, companyNameOf, reportOutcome]);

  const handleMarkPaidConfirm = useCallback(
    async (batch: readonly BulkMarkPaidBatchEntry[], body: MarkPaidBatchBody) => {
      setExecuting(true);
      setProgress({ action: 'markPaid', total: batch.length });
      try {
        const items = await runFanOut(
          batch,
          (cycleId) =>
            fetch(`/api/admin/renewals/${encodeURIComponent(cycleId)}/mark-paid-offline`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
          classifyMarkPaidOutcome,
        );
        reportOutcome('markPaid', items);
      } finally {
        setExecuting(false);
        setProgress(null);
      }
    },
    [reportOutcome],
  );

  const handleClearClick = useCallback(() => {
    setLastRunResult(null);
    onClear();
  }, [onClear]);

  if (!visible) return null;

  return (
    <>
      <div
        ref={barRef}
        className="fixed bottom-0 left-0 right-0 z-40 flex flex-col border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm shadow-lg"
        style={{ scrollMarginBottom: '80px' }}
      >
        {lastRunResult && (
          <BulkRunResultsPanel
            result={lastRunResult}
            onDismiss={() => setLastRunResult(null)}
          />
        )}
        {hasSelection && (
          <div
            role="toolbar"
            aria-label={t('toolbarLabel')}
            className="mx-auto flex w-full max-w-screen-xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" aria-live="polite">
                {t('selectedCount', { count })}
              </span>
              {overCap && (
                <div className="flex flex-col gap-0.5" role="alert">
                  <span className="text-xs font-medium text-destructive">
                    {t('overCap', { max: BULK_CAP })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('overCapHelper', { count, total: totalMatching, max: BULK_CAP })}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={executing || overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setReminderDialogOpen(true);
                }}
                className="min-h-11"
              >
                <BellIcon className="mr-1.5 h-4 w-4" />
                {t('actions.sendReminder')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={executing || overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setMarkPaidDialogOpen(true);
                }}
                className="min-h-11"
              >
                <BanknoteIcon className="mr-1.5 h-4 w-4" />
                {t('actions.markPaid')}
              </Button>
            </div>

            <Button variant="ghost" size="sm" onClick={handleClearClick} className="min-h-11">
              <XIcon className="mr-1 h-4 w-4" />
              {t('clear')}
            </Button>
          </div>
        )}
      </div>

      <div style={{ height: barHeight }} aria-hidden="true" />

      <ConfirmationDialog
        open={reminderDialogOpen}
        onOpenChange={setReminderDialogOpen}
        title={t('confirmReminderTitle', { count })}
        description={t('confirmReminderDescription')}
        confirmLabel={t('confirmReminderAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={handleSendReminders}
        finalFocus={finalFocus}
      />

      <BulkMarkPaidConfirmDialog
        open={markPaidDialogOpen}
        onOpenChange={setMarkPaidDialogOpen}
        cycleIds={selectedCycleIds}
        onConfirm={handleMarkPaidConfirm}
        finalFocus={finalFocus}
      />

      {progress && (
        <BulkProgressIndicator
          action={progress.action}
          total={progress.total}
          namespace="admin.renewals.bulk"
        />
      )}
    </>
  );
}

/**
 * Decision 5 — the persistent post-run breakdown. Renders ONLY the buckets
 * that need the treasurer's attention (never `ok` — a fully-successful run
 * has nothing left to show and clears itself, see `reportOutcome` above).
 * `orphan` is listed first: it is the do-not-retry, needs-a-human bucket.
 */
function BulkRunResultsPanel({
  result,
  onDismiss,
}: {
  readonly result: RunResult;
  readonly onDismiss: () => void;
}) {
  const t = useTranslations('admin.renewals.bulk');
  const buckets = groupByBucket(result.items);
  const heading =
    result.action === 'sendReminder' ? t('resultsHeadingReminder') : t('resultsHeadingMarkPaid');
  const sections = (['orphan', 'failed', 'rateLimited', 'skipped'] as const)
    .map((key) => ({ key, items: buckets[key] }))
    .filter((s) => s.items.length > 0);

  if (sections.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={heading}
      className="mx-auto flex w-full max-w-screen-xl flex-col gap-2 border-b px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <Button variant="ghost" size="sm" onClick={onDismiss} className="min-h-11">
          {t('resultsDismiss')}
        </Button>
      </div>
      {sections.map((section) => (
        <div key={section.key} className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t(`resultLabels.${section.key}`)}
          </h3>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {section.items.map((item) => (
              <li key={item.cycleId}>{item.companyName || item.cycleId}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
