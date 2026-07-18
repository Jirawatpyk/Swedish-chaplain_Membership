'use client';

/**
 * 107-auto-invoice Task 14 — per-row queue actions: Issue + Send / Issue
 * silently / Discard.
 *
 * Lives in the EXISTING Actions column (not the already-dense Queue-meta
 * cell Task 13 built — see that component's own review-fix A5, which made
 * the Queue column busier with always-visible price figures for touch
 * parity). A `status='draft'` auto-renewal row's Actions cell currently
 * renders nothing (no PDF, no receipt, `showRecordPayment` requires
 * `issued`/`overdue`) — this component is the ONLY content that ever
 * appears there for such a row, so there is no crowding conflict with the
 * download / record-payment controls that occupy the same cell on
 * non-draft rows (mutually exclusive by `status`).
 *
 * 320px density: ONE `ghost`/`icon` 32×32 "⋯" trigger (ux-standards.md §19
 * "Table row action cell" zone — the SAME trigger size `plans-table.tsx`
 * and the members bulk-row use), mirroring `invoice-more-menu.tsx`'s
 * established pattern in THIS exact table for "several actions, one row
 * cell". Zero extra horizontal footprint vs. three separate labelled
 * buttons, and the menu is tap/click-driven (Base UI DropdownMenu), never
 * hover-only. Discard sits inside the SAME menu as a
 * `DropdownMenuItem variant="destructive"` — ux-standards.md §19's
 * "Destructive actions in an overflow menu" clause explicitly permits this
 * exact shape ("Only `DropdownMenuItem variant="destructive"` with
 * `ConfirmationDialog` gating is allowed inside a menu, and only for
 * low-irreversibility items") — Discard is recoverable (the next auto-draft
 * cron pass re-drafts, or the treasurer bills manually), unlike a permanent
 * erasure.
 *
 * Each of the 3 items opens its OWN `ConfirmationDialog` (built on shadcn
 * `AlertDialog` — ux-standards.md §6.2: focus starts on Cancel, destructive
 * Confirm is red, spinner while submitting, dialog stays open on failure).
 * `closeOnConfirm={false}` on both — the parent (this component) owns the
 * close so a FAILED issue/discard keeps the dialog open with an inline,
 * focused `role="alert"` error (§6.4: never a transient toast for a
 * failure on a money mutation) while a SUCCESS closes + toasts +
 * `router.refresh()`.
 *
 * Refusal-reason parity (Task 14 brief §3): `plan_year_drift` /
 * `member_terminated` / `duplicate_live_bill` render via the SAME
 * `admin.invoices.list.queue.refusalReason.*` i18n keys Task 13's
 * `<AutoRenewalQueueBadges>` already uses for the SAME three reasons — see
 * `issue-auto-draft-error-routing.ts`. A row the queue showed as clean must
 * never surprise the admin with a different-sounding refusal here.
 *
 * Focus-on-close (review round 1, BLOCKING): a successful Discard is a hard
 * DELETE and a successful Issue flips `status` away from `'draft'` — either
 * way `router.refresh()` removes THIS component's own trigger button from
 * the actionable set (this component itself re-renders `null` once the
 * refreshed `status` prop is no longer `'draft'`). Base UI's DEFAULT
 * focus-return targets the original trigger; if it has unmounted by the
 * time focus-return runs, focus silently drops to `<body>` — a real problem
 * in a row-by-row batch workflow (dozens of rows/sitting, the feature's
 * whole reason for existing). Fixed by wiring `finalFocus` via
 * `useDialogFinalFocus` — REUSED verbatim from
 * `@/components/broadcast/reason-confirmation-dialog` (the identical
 * unmount-after-close problem the broadcast Approve/Reject/Cancel dialogs
 * already solved; see that hook's own docstring), not reimplemented. On
 * Cancel/ESC the trigger survives and gets focus back (Base UI's own
 * default, unaffected). On a SUCCESSFUL close, `closedViaSuccessRef` is
 * raised BEFORE the close so the resolver skips the about-to-unmount
 * trigger and lands on the `#main-content` landmark instead.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  MoreHorizontalIcon,
  AlertTriangleIcon,
  FileCheckIcon,
  MailIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import {
  routeDiscardAutoDraftError,
  routeIssueAutoDraftError,
} from './issue-auto-draft-error-routing';

type ActiveAction = 'send' | 'silent' | 'discard' | null;

/**
 * 107-auto-invoice Task 14 review (MINOR) — a 429 from either route must
 * read as "wait a moment", not as a generic failure. The routes serialise
 * `{error:{code:'rate_limited', retryAfterMs}}` (`rateLimitedJson`,
 * `@/lib/rate-limit-helpers`) regardless of which one fired; `res.status
 * === 429` is checked BEFORE the route-specific error router (which has no
 * `rate_limited` branch — this is the ONE code shared verbatim by both
 * routes' error envelopes) so both handlers reuse one message builder.
 */
async function rateLimitMessage(
  t: ReturnType<typeof useTranslations>,
  res: Response,
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { retryAfterMs?: number };
  } | null;
  const retryAfterMs = body?.error?.retryAfterMs;
  const seconds =
    typeof retryAfterMs === 'number' ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
  return seconds === null
    ? t('errors.rateLimited')
    : t('errors.rateLimitedWithSeconds', { seconds });
}

export interface AutoRenewalQueueActionsProps {
  readonly invoiceId: string;
  /** Buyer display name — used ONLY for dialog copy + aria-labels; a draft
   * row's `documentNumber` is always '—' (no §87/SC number minted yet), so
   * this is the only stable per-row identifier available for context. */
  readonly memberName: string;
  /** Only `'draft'` rows are actionable — every other status renders
   * nothing (mirrors `InvoiceMoreMenu`'s `visibleCount === 0 → null`). */
  readonly status: string;
}

export function AutoRenewalQueueActions({
  invoiceId,
  memberName,
  status,
}: AutoRenewalQueueActionsProps) {
  const t = useTranslations('admin.invoices.autoRenewalQueue.actions');
  const tQueue = useTranslations('admin.invoices.list.queue');
  const router = useRouter();

  const [active, setActive] = useState<ActiveAction>(null);
  const [error, setError] = useState<{
    readonly message: string;
    readonly conflictingInvoiceId?: string;
  } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Focus-on-close (see module header) — the "⋯" trigger this component
  // renders itself, and a flag raised right before every SUCCESSFUL close
  // (the only closes that unmount the trigger via `router.refresh()`).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);

  // FR-032 / §6.4 pattern (mirrors `issue-invoice-form.tsx`'s `formError`
  // effect) — a plain synchronous `errorRef.current?.focus()` right after
  // `setError(...)` targets the ref while it is still `null` (the DOM
  // hasn't committed the new Alert yet), a silent no-op. An effect fixes
  // the ordering, but is NOT sufficient on its own here: the error Alert
  // mounts as a NEW child of the still-open `ConfirmationDialog`, and Base
  // UI's own focus-management re-asserts its `initialFocus` (Cancel) in
  // response to that same content change, winning the race against a
  // same-tick `.focus()` call (verified empirically — Cancel silently
  // reclaimed focus within one tick). Chained double-RAF defers past Base
  // UI's own re-assertion, mirroring `reason-confirmation-dialog.tsx`'s
  // identical "auto-focus inside an open Base UI dialog" pattern.
  useEffect(() => {
    if (!error) return undefined;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        errorRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2 !== 0) window.cancelAnimationFrame(raf2);
    };
  }, [error]);

  // Draft-only surface — nothing to render once the row has moved on
  // (issued / paid / void / …), whether via THIS component or a
  // concurrent writer (another admin tab, the reconcile cron, a sibling
  // sweep). Mirrors `InvoiceMoreMenu`'s early-return convention.
  if (status !== 'draft') return null;

  function openDialog(action: Exclude<ActiveAction, null>) {
    setError(null);
    setActive(action);
  }

  function closeDialog(open: boolean) {
    if (!open) {
      setActive(null);
      setError(null);
    }
  }

  async function handleIssue(sendEmail: boolean) {
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/invoices/${invoiceId}/issue-auto-drafted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sendEmail }),
      });
    } catch {
      setError({ message: t('errors.network') });
      return;
    }
    if (res.status === 429) {
      setError({ message: await rateLimitMessage(t, res) });
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; reason?: string; conflicting_invoice_id?: string };
      } | null;
      const routing = routeIssueAutoDraftError(body?.error ?? null);
      const message =
        routing.kind === 'refusal_reason'
          ? tQueue(`refusalReason.${routing.reasonKey}`)
          : t(`errors.${routing.messageKey}`);
      setError({
        message,
        ...(routing.kind === 'refusal_reason' && routing.conflictingInvoiceId
          ? { conflictingInvoiceId: routing.conflictingInvoiceId }
          : {}),
      });
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      invoice_number?: string;
      supersede_warnings?: readonly string[];
    };
    const warnings = body.supersede_warnings ?? [];
    toast.success(
      sendEmail
        ? t('toast.issuedAndSent', { number: body.invoice_number ?? '' })
        : t('toast.issuedSilently', { number: body.invoice_number ?? '' }),
      warnings.length > 0 ? { description: warnings.join(' ') } : undefined,
    );
    // Success unmounts the trigger (status flips away from 'draft' on
    // refresh) — see module header. Must be set BEFORE the close so
    // `finalFocus` (read at close time) observes it.
    closedViaSuccessRef.current = true;
    setActive(null);
    router.refresh();
  }

  async function handleDiscard() {
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/invoices/${invoiceId}/discard-auto-draft`, {
        method: 'POST',
      });
    } catch {
      setError({ message: t('errors.network') });
      return;
    }
    if (res.status === 429) {
      setError({ message: await rateLimitMessage(t, res) });
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      const key = routeDiscardAutoDraftError(body?.error?.code ?? null);
      setError({ message: t(`errors.${key}`) });
      return;
    }
    toast.success(t('toast.discarded'));
    // See handleIssue's identical comment — success unmounts the trigger.
    closedViaSuccessRef.current = true;
    setActive(null);
    router.refresh();
  }

  const errorAlert = error && (
    <Alert
      ref={errorRef}
      tabIndex={-1}
      variant="destructive"
      role="alert"
      className="outline-none"
      data-testid="queue-row-action-error"
    >
      <AlertTriangleIcon className="size-4" aria-hidden="true" />
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{error.message}</span>
        {error.conflictingInvoiceId && (
          // Review round 1 SHOULD-FIX — 44×44 target, matching the IDENTICAL
          // link in `auto-renewal-queue-badges.tsx` (Task 13 review A7):
          // same key, same page, same meaning, so the same target-size
          // standard applies.
          <Link
            href={`/admin/invoices/${error.conflictingInvoiceId}`}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'min-h-11 gap-1 px-3',
            )}
          >
            {tQueue('viewConflictingInvoice')}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(props) => (
            <Button
              {...props}
              ref={triggerRef}
              variant="ghost"
              size="icon"
              aria-label={t('menuAria', { member: memberName })}
              data-testid="queue-row-actions-trigger"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          )}
        />
        {/* Review round 1 SHOULD-FIX — visual weight now matches real risk,
            not the reverse. "Issue and email" mints an irreversible §87
            document AND emails a real member; it previously sat icon-less
            at the top with no more visual weight than "Issue silently".
            Reordered (silently first — the lower-external-impact choice)
            and iconified every item (mirrors `invoice-more-menu.tsx`'s
            icon-per-item convention on this same page) so the Mail icon on
            "Issue and email" makes its externally-visible side effect
            legible without reading the label. */}
        <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
          <DropdownMenuItem
            onClick={() => openDialog('silent')}
            data-testid="queue-row-issue-silent"
          >
            <FileCheckIcon aria-hidden="true" />
            {t('issueSilently')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openDialog('send')}
            data-testid="queue-row-issue-send"
          >
            <MailIcon aria-hidden="true" />
            {t('issueAndSend')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => openDialog('discard')}
            data-testid="queue-row-discard"
          >
            <Trash2Icon aria-hidden="true" />
            {t('discard')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmationDialog
        open={active === 'send' || active === 'silent'}
        onOpenChange={closeDialog}
        title={active === 'silent' ? t('silentDialog.title') : t('sendDialog.title')}
        description={
          active === 'silent'
            ? t('silentDialog.description', { member: memberName })
            : t('sendDialog.description', { member: memberName })
        }
        confirmLabel={active === 'silent' ? t('issueSilently') : t('issueAndSend')}
        cancelLabel={t('cancel')}
        closeOnConfirm={false}
        onConfirm={() => handleIssue(active === 'send')}
        finalFocus={finalFocus}
      >
        {errorAlert}
      </ConfirmationDialog>

      <ConfirmationDialog
        open={active === 'discard'}
        onOpenChange={closeDialog}
        title={t('discardDialog.title')}
        description={t('discardDialog.description', { member: memberName })}
        confirmLabel={t('discard')}
        cancelLabel={t('cancel')}
        destructive
        closeOnConfirm={false}
        onConfirm={handleDiscard}
        finalFocus={finalFocus}
      >
        {errorAlert}
      </ConfirmationDialog>
    </>
  );
}
