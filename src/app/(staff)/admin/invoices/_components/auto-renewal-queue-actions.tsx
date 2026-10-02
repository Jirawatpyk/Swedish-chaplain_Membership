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
 * 320px density: ONE "⋯" `IconButton` opening an AURA `DropdownMenu`
 * (spec 122 US8 T803) — the same shape as the row's own ⋯ menu in this
 * table. Zero extra horizontal footprint vs. three separate labelled
 * buttons, and the menu is tap/click-driven, never hover-only. Discard sits
 * in the SAME menu as a `tone: 'danger'` item after a separator, gated by a
 * `ConfirmationDialog` — allowed in a menu only for low-irreversibility
 * items (ux-standards.md §19): Discard is recoverable (the next auto-draft
 * cron pass re-drafts, or the treasurer bills manually).
 *
 * Each of the 3 items opens its OWN `ConfirmationDialog` (AURA's
 * alertdialog — ux-standards.md §6.2: focus starts on Cancel, destructive
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
 * refreshed `status` prop is no longer `'draft'`). The dialog's DEFAULT
 * focus-return targets the original trigger; if it has unmounted by the
 * time focus-return runs, focus silently drops to `<body>` — a real problem
 * in a row-by-row batch workflow (dozens of rows/sitting, the feature's
 * whole reason for existing). Fixed by wiring `finalFocus` through
 * `resolveDialogFinalFocus` (the resolver the broadcast and renewal dialogs
 * share). On Cancel/ESC the trigger survives and gets focus back. On a
 * SUCCESSFUL close, `closedViaSuccessRef` is raised BEFORE the close so the
 * resolver skips the about-to-unmount trigger and lands on the
 * `#main-content` landmark instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, DropdownMenu, IconButton, buttonClass, type MenuItem } from '@jirawatpyk/aura-react';
import { FileCheckIcon, MailIcon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import {
  routeDiscardAutoDraftError,
  routeIssueAutoDraftError,
} from './issue-auto-draft-error-routing';
import { useSupersedeWarningToast } from '@/components/invoices/use-supersede-warning-toast';

type ActiveAction = 'send' | 'silent' | 'discard' | null;

/**
 * The row's queue-prediction state that warrants a CAUTION at the Issue
 * commit point (2026-07 UX audit). These are the states where an Issue would
 * SUCCEED but might mint a §86/4 at a wrong/unverified amount — as opposed to
 * a `refusalReason` (plan-year drift / duplicate bill / terminated / erased),
 * which the server guards REFUSE outright, so no caution is needed for those.
 *   - `unresolved` — whole-row enrichment failed; every prediction is suspect.
 *   - `priceUnverifiable` — the price could not be confirmed vs the catalogue.
 *   - `priceChanged` — the plan price changed after the draft was created.
 * `null` = a clean row, no caution. The Queue column already badges these
 * (AutoRenewalQueueBadges); this repeats the highest-priority one at the
 * irreversible commit point, where the badge is 3 columns away under scroll.
 */
export type IssueCautionKind =
  | 'unresolved'
  | 'priceUnverifiable'
  | 'priceChanged'
  | null;

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
  /** The highest-priority queue-prediction caution for this row, or `null`
   * for a clean row. Surfaced inside the Issue confirmation dialog so the
   * treasurer sees it at the irreversible §87-minting commit point, not only
   * in the (scroll-distant) Queue column. Does NOT gate the action. */
  readonly issueCaution?: IssueCautionKind;
}

export function AutoRenewalQueueActions({
  invoiceId,
  memberName,
  status,
  issueCaution = null,
}: AutoRenewalQueueActionsProps) {
  const t = useTranslations('admin.invoices.autoRenewalQueue.actions');
  const tQueue = useTranslations('admin.invoices.list.queue');
  const showSupersedeWarning = useSupersedeWarningToast();
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
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef.current,
        trigger: triggerRef.current,
        fallback: null,
        mainContent: typeof document !== 'undefined' ? document.getElementById('main-content') : null,
      }),
    [],
  );

  // FR-032 / §6.4 pattern (mirrors `issue-invoice-form.tsx`'s `formError`
  // effect) — a plain synchronous `errorRef.current?.focus()` right after
  // `setError(...)` targets the ref while it is still `null` (the DOM
  // hasn't committed the new Alert yet), a silent no-op. The chained
  // double-RAF also defers past the open dialog's own initial-focus pass,
  // so Cancel never reclaims focus from the error.
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
      supersede_issues?: unknown;
    };
    toast.success(
      sendEmail
        ? t('toast.issuedAndSent', { number: body.invoice_number ?? '' })
        : t('toast.issuedSilently', { number: body.invoice_number ?? '' }),
    );
    // 106-void-on-reissue follow-up — the bill WAS issued, but an older
    // unpaid bill may still be open; see `useSupersedeWarningToast`.
    showSupersedeWarning(body);
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

  // 2026-07 UX audit — a warning shown INSIDE the Issue dialog for a row the
  // Queue column flagged (unverified/changed price, or unresolved enrichment),
  // so the irreversible §87 mint carries the caution at the commit point. Not
  // rendered for Discard (discarding a flagged row is exactly the safe action).
  const cautionAlert = issueCaution && (
    <Alert tone="warning" role="note" data-testid="queue-row-issue-caution">
      {t(`issueCaution.${issueCaution}`)}
    </Alert>
  );

  const errorAlert = error && (
    <Alert
      ref={errorRef}
      tabIndex={-1}
      tone="danger"
      role="alert"
      className="outline-none"
      data-testid="queue-row-action-error"
      action={
        error.conflictingInvoiceId ? (
          // The same 44×44 target as the identical link in
          // `auto-renewal-queue-badges.tsx` (Task 13 review A7).
          <Link
            href={`/admin/invoices/${error.conflictingInvoiceId}`}
            className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
          >
            {tQueue('viewConflictingInvoice')}
          </Link>
        ) : undefined
      }
    >
      {error.message}
    </Alert>
  );

  // Review round 1 SHOULD-FIX — visual weight matches real risk: "Issue
  // silently" first (the lower external impact), "Issue and email" (mints a
  // §87 document AND emails a member) second with the mail icon, then
  // Discard last after a separator in the danger tone.
  const items: MenuItem[] = [
    { label: t('issueSilently'), icon: <FileCheckIcon />, onSelect: () => openDialog('silent') },
    { label: t('issueAndSend'), icon: <MailIcon />, onSelect: () => openDialog('send') },
    { separator: true },
    { label: t('discard'), icon: 'trash-2', tone: 'danger', onSelect: () => openDialog('discard') },
  ];

  return (
    <>
      <DropdownMenu
        label={t('menuAria', { member: memberName })}
        trigger={
          <IconButton
            ref={triggerRef}
            icon="ellipsis"
            size="sm"
            touchHeight
            label={t('menuAria', { member: memberName })}
            data-testid="queue-row-actions-trigger"
          />
        }
        items={items}
      />

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
        {cautionAlert}
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
