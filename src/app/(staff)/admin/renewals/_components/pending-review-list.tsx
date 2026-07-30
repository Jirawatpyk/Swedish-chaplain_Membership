/**
 * 070 F8 item #18 — `PendingReviewList`.
 *
 * Renders the "Pending review" discovery table: cycles in
 * `pending_admin_reactivation` that need an admin approve/reject decision.
 *
 * Pre-formatted date strings (already locale-/BE-formatted on the server)
 * are passed in so this client component stays locale-agnostic — matching
 * the cycle-detail page's day-grain date treatment.
 *
 * UX-A Bug 2: a row whose cycle carries the async reject-with-refund marker
 * (`refundSettling`) has ALREADY been decided (rejected; refund settling) — it
 * only sits in this pending-status list until the reconcile cron converges it
 * to `cancelled`. It renders a distinct "Refund settling" pill and a read-only
 * "View" CTA (not "Review") so the queue doesn't overstate open work.
 *
 * B2 (UX-audit PR-B #7): an OPEN row (`refundSettling === false`) gets an inline
 * **Approve** action for admins (`canApprove`) — the SAME non-destructive
 * confirm + POST `/reactivate` flow as the cycle-detail `PendingReactivationActions`
 * — so a reactivation can be approved without leaving the list. The DESTRUCTIVE
 * reject-with-refund path stays on the detail page (money + irreversible). A
 * read-only viewer (manager) sees only the "Review" link. On a successful
 * approve the row unmounts (the cycle leaves `pending_admin_reactivation`), so
 * the confirm dialog's `finalFocus` falls back to `#main-content` instead of
 * dropping focus to `<body>` (PR-A dialog-focus lesson).
 */
'use client';

import { useMemo, useRef, useState, useTransition, type RefObject } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellOff,
  Loader2Icon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shell/empty-state';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';

export interface PendingReviewRow {
  readonly cycleId: string;
  readonly companyName: string;
  /**
   * B4 — the F3 member id when the batch enrichment resolved this cycle's
   * member. Drives the `/admin/members/{memberId}` company link. `null` when
   * the member is absent from the map (archived / cross-tenant-hidden) — the
   * cell then renders the company text (a cycle short-id fallback) plainly.
   */
  readonly memberId: string | null;
  /**
   * B4 — the pre-formatted `SCCM-NNNN` member number (server-formatted with the
   * per-tenant prefix). `null` when the member is absent from the batch map.
   */
  readonly memberNumberDisplay: string | null;
  readonly pendingSinceLabel: string;
  /**
   * B3 — the raw `enteredPendingAt` epoch (ms) the client sorts on. Kept
   * separate from `pendingSinceLabel` (which is the localized/BE display
   * string): sorting a formatted date string is locale-fragile, so the
   * ordering keys off this numeric value. `NaN` (missing timestamp) sorts last.
   */
  readonly pendingSinceEpoch: number;
  readonly expiryLabel: string;
  /**
   * UX-A Bug 2 — true when the cycle carries the async reject-with-refund
   * marker: already rejected, refund settling, awaiting cron convergence to
   * `cancelled`. Drives the "Refund settling" pill + read-only "View" CTA.
   */
  readonly refundSettling: boolean;
  /**
   * B3 — true when the cycle has been pending longer than the aging threshold
   * (`PENDING_REVIEW_AGING_DAYS`). Drives the subtle amber "Aged {n}d" chip.
   */
  readonly isAged: boolean;
  /** B3 — whole days this cycle has been pending (chip label + title). */
  readonly agingDays: number;
}

export interface PendingReviewListProps {
  readonly rows: ReadonlyArray<PendingReviewRow>;
  /**
   * B2 — admin-only gate for the inline Approve action, matching how the
   * surface's mutations are already gated (`role === 'admin'`; managers view
   * this queue read-only). Defaults to `false` so a read-only viewer never sees
   * an Approve CTA that would just 403 at the (admin-only) reactivate route.
   */
  readonly canApprove?: boolean;
}

/** B2 — an inline-Approve launch target: which cycle + the row's focus resolver. */
interface ApproveTarget {
  readonly cycleId: string;
  readonly finalFocus: () => HTMLElement | null;
}

/** Read `error.code` off a non-2xx JSON body; falls back to server_error. */
async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? 'server_error';
  } catch {
    return 'server_error';
  }
}

export function PendingReviewList({
  rows,
  canApprove = false,
}: PendingReviewListProps) {
  const t = useTranslations('admin.renewals.pendingReview');
  // B2 — reuse the cycle-detail Approve copy VERBATIM so the wording stays
  // identical across the two surfaces.
  const tReactivate = useTranslations(
    'admin.renewals.cycleDetail.pendingReactivation',
  );
  const router = useRouter();

  // B3 — client-side sort on the RAW pending-since epoch (never the localized
  // display string). Default 'asc' = oldest-first so the most-aged decisions
  // lead. The list is small + fully materialised (no pagination), so a client
  // toggle is sufficient and adds no server param.
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // B2 — the single lifted Approve confirm dialog. `approveTarget` carries the
  // launching row's cycleId + finalFocus resolver so one dialog serves every
  // row (escalation-queue pattern).
  const [approveTarget, setApproveTarget] = useState<ApproveTarget | null>(null);
  const [approvePending, startApprove] = useTransition();
  // Raised on the programmatic close paths (success / 409) that run
  // router.refresh() and unmount the launching row — the row's finalFocus
  // resolver then skips the vanishing Approve trigger and lands on
  // #main-content instead of dropping focus to <body> (WCAG 2.1 AA SC 2.4.3).
  const closedViaSuccessRef = useRef(false);
  const approveCancelRef = useRef<HTMLButtonElement | null>(null);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aBad = !Number.isFinite(a.pendingSinceEpoch);
      const bBad = !Number.isFinite(b.pendingSinceEpoch);
      // A missing timestamp (NaN) sorts LAST in both directions — it can never
      // be "the most aged" nor jump the newest-first order.
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return sortDir === 'asc'
        ? a.pendingSinceEpoch - b.pendingSinceEpoch
        : b.pendingSinceEpoch - a.pendingSinceEpoch;
    });
    return copy;
  }, [rows, sortDir]);

  // Opening the dialog resets the success flag so a plain Cancel / ESC returns
  // focus to the launching Approve trigger; the confirm handler re-raises it on
  // a success / 409 just before the row unmounts.
  const openApprove = (target: ApproveTarget): void => {
    closedViaSuccessRef.current = false;
    setApproveTarget(target);
  };

  const onApproveConfirm = (): void => {
    const target = approveTarget;
    if (target === null) return;
    startApprove(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(target.cycleId)}/reactivate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        );
        if (!res.ok) {
          const code = await readErrorCode(res);
          // Copied verbatim from PendingReactivationActions: a 409
          // `reject_refund_in_progress` means the cycle was rejected (async
          // refund in flight) between render and click. Surface the specific
          // reason and refresh so the row re-renders into the settling state
          // (its Approve disappears → trigger unmounts → land on #main-content).
          if (code === 'reject_refund_in_progress') {
            toast.error(tReactivate('reactivate.errorRefundInProgressToast'));
            closedViaSuccessRef.current = true;
            setApproveTarget(null);
            router.refresh();
            return;
          }
          // Generic failure — keep the dialog open for retry; the row survives,
          // so on a later Cancel focus returns to its Approve trigger.
          toast.error(tReactivate('reactivate.errorToast'));
          return;
        }
        toast.success(tReactivate('reactivate.successToast'));
        // Success unmounts the row (cycle leaves `pending_admin_reactivation`).
        closedViaSuccessRef.current = true;
        setApproveTarget(null);
        router.refresh();
      } catch {
        toast.error(tReactivate('reactivate.errorToast'));
      }
    });
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BellOff}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    );
  }

  const SortIcon = sortDir === 'asc' ? ArrowUpIcon : ArrowDownIcon;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.member')}</TableHead>
            {/* B3 — sortable "Pending since". `aria-sort` lives on the
                columnheader (WCAG 1.3.1 / 4.1.2); the button carries the action
                label (what the next click does) + the direction caret. Mirrors
                the pipeline's sortable-header treatment (button/anchor + caret). */}
            <TableHead
              aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}
            >
              <button
                type="button"
                onClick={() =>
                  setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                }
                aria-label={t(
                  sortDir === 'asc'
                    ? 'sortPendingSinceToNewest'
                    : 'sortPendingSinceToOldest',
                )}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              >
                {t('columns.pendingSince')}
                <SortIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </TableHead>
            <TableHead>{t('columns.expiry')}</TableHead>
            <TableHead className="text-right">{t('columns.action')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row) => (
            <TableRow key={row.cycleId}>
              <TableCell className="font-medium">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* B4 — company links to the F3 member (escalation-queue +
                      invoice-table parity); a member absent from the batch map
                      degrades to plain text (a cycle short-id, never a broken
                      `/admin/members/` link with an empty id). */}
                  {row.memberId !== null ? (
                    <Link
                      href={`/admin/members/${row.memberId}`}
                      className="font-medium text-primary underline-offset-4 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    >
                      {row.companyName}
                    </Link>
                  ) : (
                    <span>{row.companyName}</span>
                  )}
                  {/* B4 — SCCM member number in muted secondary text (members-
                      table / invoice-table convention); tabular-nums so the
                      NNNN digits align down the column. */}
                  {row.memberNumberDisplay !== null && (
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {row.memberNumberDisplay}
                    </span>
                  )}
                  {row.refundSettling && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600">
                      {t('settlingPill')}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{row.pendingSinceLabel}</span>
                  {/* B3 — subtle amber "Aged {n}d" chip on decisions lingering
                      past the threshold. Reuses the `settlingPill` amber styling
                      for visual consistency (never a new colour); placed here (not
                      the Member cell) so it sits beside the pending date it
                      describes and never clashes with the "Refund settling" pill. */}
                  {row.isAged && (
                    <span
                      title={t('agedChipTitle', { days: row.agingDays })}
                      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600"
                    >
                      {t('agedChip', { days: row.agingDays })}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.expiryLabel}
              </TableCell>
              <TableCell className="text-right">
                {/* B2 — an OPEN row gets an inline Approve (admins) + a Review
                    link. A refund-settling row (decided) keeps the read-only
                    View link only; a read-only viewer (manager) sees Review
                    only — no Approve CTA that would just 403. */}
                {canApprove && !row.refundSettling ? (
                  <PendingReviewRowActions
                    row={row}
                    busy={
                      approvePending && approveTarget?.cycleId === row.cycleId
                    }
                    closedViaSuccessRef={closedViaSuccessRef}
                    onApprove={openApprove}
                    t={t}
                  />
                ) : (
                  <Link
                    href={`/admin/renewals/${row.cycleId}`}
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'sm',
                    })}
                  >
                    {/* UX-A Bug 2: read-only "View" for a decided
                        (refund-settling) row so the queue doesn't imply open
                        review work. */}
                    {row.refundSettling ? t('viewAction') : t('openAction')}
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* B2 — one lifted, non-destructive Approve confirm dialog serving every
          row (reuses the detail-page Approve copy + `/reactivate` flow). Only
          mounted for admins; managers never approve. */}
      {canApprove && (
        <Dialog
          open={approveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setApproveTarget(null);
          }}
        >
          {/* `finalFocus` = the launching row's resolver, captured by Base UI
              at open. On a success/409 close the row unmounts and
              `closedViaSuccessRef` (raised before close) makes the resolver skip
              the vanishing trigger → #main-content; on Cancel/ESC it returns the
              still-mounted Approve trigger. Without this prop the whole
              focus-return mechanism is inert (WCAG 2.1 AA SC 2.4.3). */}
          <DialogContent
            initialFocus={approveCancelRef}
            finalFocus={approveTarget?.finalFocus}
            role="alertdialog"
          >
            <DialogHeader>
              <DialogTitle>{tReactivate('reactivate.dialogTitle')}</DialogTitle>
              <DialogDescription>
                {tReactivate('reactivate.dialogBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={approveCancelRef}
                variant="outline"
                onClick={() => setApproveTarget(null)}
                disabled={approvePending}
              >
                {tReactivate('reactivate.cancel')}
              </Button>
              <Button onClick={onApproveConfirm} disabled={approvePending}>
                {approvePending ? (
                  <>
                    <Loader2Icon
                      className="size-4 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                    {tReactivate('reactivate.submitting')}
                  </>
                ) : (
                  tReactivate('reactivate.confirm')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * B2 — per-row inline-Approve cluster: a visible Approve primary + a Review
 * link. Split out of the row map so it can own the row's Approve-trigger ref +
 * `useDialogFinalFocus` resolver (hooks can't live in a `.map()` callback). The
 * resolver returns the Approve trigger on cancel, and #main-content when a
 * successful approve unmounts the row. Admin-gated by the caller (`canApprove`).
 */
function PendingReviewRowActions({
  row,
  busy,
  closedViaSuccessRef,
  onApprove,
  t,
}: {
  readonly row: PendingReviewRow;
  readonly busy: boolean;
  readonly closedViaSuccessRef: RefObject<boolean>;
  readonly onApprove: (target: ApproveTarget) => void;
  readonly t: ReturnType<typeof useTranslations<'admin.renewals.pendingReview'>>;
}) {
  const approveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const finalFocus = useDialogFinalFocus(
    approveTriggerRef,
    undefined,
    closedViaSuccessRef,
  );
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        ref={approveTriggerRef}
        size="sm"
        disabled={busy}
        aria-busy={busy}
        // Per-row accessible name so SR users tabbing the queue know WHICH
        // member they're about to approve (multiple identical "Approve" buttons
        // would otherwise be ambiguous). Mirrors the escalation ⋯-trigger idiom.
        aria-label={t('approveRowAria', { company: row.companyName })}
        onClick={() => onApprove({ cycleId: row.cycleId, finalFocus })}
      >
        {t('approveAction')}
      </Button>
      <Link
        href={`/admin/renewals/${row.cycleId}`}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {t('openAction')}
      </Link>
    </div>
  );
}
