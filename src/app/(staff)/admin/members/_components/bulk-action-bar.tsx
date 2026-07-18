'use client';

/**
 * T109 — Sticky-bottom bulk action toolbar (US4 FR-018/040).
 *
 * Appears when ≥1 row is selected. Shows "N selected" counter + action
 * menu + Clear affordance. Uses `scroll-margin-bottom` to prevent the
 * bar from obscuring focused elements (ADOPT-01 / WCAG 2.2 SC 2.4.11).
 *
 * Cap enforcement: if > 100 rows are selected, the action buttons are
 * disabled with a message instructing the admin to split the operation.
 *
 * Focus-on-close (107-auto-invoice Task 15 review, UX-1). EVERY successful
 * bulk action unmounts this entire bar: `executeBulk` calls `onClear()` →
 * the parent clears `selectedIds` → `count === 0` → this component returns
 * `null`. So all three trigger buttons vanish, and Base UI's default
 * focus-return (the original trigger) drops focus to `<body>` — a keyboard
 * or screen-reader user must re-Tab from the top of the page after every
 * bulk action. Fixed with ONE shared `finalFocus` for all three dialogs,
 * built from `useDialogFinalFocus` (REUSED verbatim from
 * `@/components/broadcast/reason-confirmation-dialog`, same as
 * `auto-renewal-queue-actions.tsx` — not reimplemented). `lastTriggerRef`
 * records whichever button opened the dialog (only one can be open at a
 * time); `closedViaSuccessRef` is raised inside `executeBulk` BEFORE
 * `onClear()`, so on a successful close the resolver skips the
 * about-to-unmount trigger and lands on the `#main-content` landmark. On
 * Cancel / ESC / a failed action the bar survives, the flag stays false,
 * and focus returns to the trigger as normal. WCAG 2.1 AA SC 2.4.3.
 *
 * This was pre-existing on Archive and Send-invite; Task 15 added the third
 * case and fixes all three together.
 */

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArchiveIcon, FileTextIcon, MailIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ArchiveConfirmDialog } from './archive-confirm-dialog';
import { BulkProgressIndicator } from './bulk-progress-indicator';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { BULK_CAP } from '@/lib/members-bulk-constants';

// I9 round-10 ui-design-specialist — `change_plan` was declared but
// never surfaced as a button (only Archive + Send-Portal-Invite render
// below). Dropped from the union so a future refactor can't fork to
// dead code; if reintroduced, add both the button AND the union entry
// in the same diff. The i18n string `admin.members.bulk.actions.change_plan`
// is preserved for if/when the button lands.
type BulkAction = 'archive' | 'send_portal_invite' | 'enrol_auto_invoice';

type Props = {
  readonly selectedIds: string[];
  readonly selectedCompanyNames: string[];
  /**
   * Total rows matching the current directory filter (across ALL
   * pages). Used by `overCapHelper` to say "X of Y matching" rather
   * than the tautological "X of X selected" the initial cut produced.
   */
  readonly totalMatching: number;
  readonly onClear: () => void;
};

export function BulkActionBar({
  selectedIds,
  selectedCompanyNames,
  totalMatching,
  onClear,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const router = useRouter();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [enrolDialogOpen, setEnrolDialogOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{
    action: string;
    total: number;
  } | null>(null);

  const count = selectedIds.length;
  const overCap = count > BULK_CAP;

  // Focus-on-close (see module header). One ref pair serves all three
  // dialogs — only one can be open at a time, and every successful action
  // unmounts all three triggers together.
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(
    lastTriggerRef,
    undefined,
    closedViaSuccessRef,
  );

  const executeBulk = useCallback(
    async (action: BulkAction, params?: Record<string, unknown>) => {
      if (overCap) return;
      // Reset per attempt: a failed action leaves the bar (and its
      // triggers) mounted, so focus must return to the trigger, not the
      // landmark. Only the success path below raises this.
      closedViaSuccessRef.current = false;
      setExecuting(true);
      setProgress({ action, total: count });

      try {
        const res = await fetch('/api/members/bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            action,
            member_ids: selectedIds,
            ...(params ? { params } : {}),
          }),
        });

        const body = await res.json();

        if (res.ok) {
          if (action === 'send_portal_invite') {
            // P1-17 — per-member buckets (queued / skipped / failed). Partial
            // success is still 200; surface the breakdown + use an error toast
            // only when at least one member failed (bad data / transient).
            const c = body.counts ?? { invited: 0, skipped: 0, failed: 0 };
            const parts = [t('inviteQueued', { invited: c.invited })];
            if (c.skipped > 0) parts.push(t('inviteSkipped', { skipped: c.skipped }));
            if (c.failed > 0) parts.push(t('inviteFailed', { failed: c.failed }));
            const message = parts.join(' · ');
            // Only a green success when at least one invite was actually queued.
            // If every member was skipped (e.g. all already linked → invited=0,
            // failed=0) nothing was done, so use a neutral info toast — a success
            // tick on a no-op misleads the admin into thinking invites were sent.
            if (c.failed > 0) toast.error(message);
            else if (c.invited > 0) toast.success(message);
            else toast.info(message);
          } else if (action === 'enrol_auto_invoice') {
            // Per-member skip buckets, same shape as the invite arm. There
            // is no `failed` bucket here — the endpoint is all-or-nothing,
            // so any real failure arrives as a non-2xx and never reaches
            // this branch.
            //
            // Defaulted for the same reason the invite arm defaults `counts`:
            // an `undefined` reaching an ICU `{enrolled, plural, …}` throws
            // FORMATTING_ERROR inside the toast call and silently eats the
            // entire confirmation. Not reachable while the route always
            // returns all three keys — this keeps the two arms symmetric so a
            // future response-shape change degrades instead of disappearing.
            const c = {
              enrolled: 0,
              skipped_already: 0,
              skipped_terminated: 0,
              ...(body ?? {}),
            };
            const parts = [t('enrolSucceeded', { enrolled: c.enrolled })];
            if (c.skipped_already > 0) {
              parts.push(t('enrolSkippedAlready', { skipped: c.skipped_already }));
            }
            if (c.skipped_terminated > 0) {
              parts.push(
                t('enrolSkippedTerminated', { skipped: c.skipped_terminated }),
              );
            }
            const message = parts.join(' · ');
            // A no-op (everyone already enrolled / terminated) gets a neutral
            // info toast — a green tick on zero writes misleads the admin into
            // thinking the roster changed.
            if (c.enrolled > 0) toast.success(message);
            else toast.info(message);
          } else {
            toast.success(
              t('success', {
                count: body.updated_count,
                action: t(`actions.${action}`),
              }),
            );
          }
          // Raise BEFORE onClear(): `onClear` is what unmounts this whole
          // bar (and every trigger in it), and Base UI reads `finalFocus`
          // when the dialog closes just after this callback resolves.
          closedViaSuccessRef.current = true;
          onClear();
          router.refresh();
        } else if (res.status === 429) {
          toast.error(t('rateLimited'));
        } else {
          // Map the server error CODE to localized copy — never render the
          // server's raw English `error.message` (state_error's message even
          // embeds a member UUID, see bulk/route.ts). Unknown codes fall back
          // to a generic localized message.
          const code = body.error?.code;
          const key = typeof code === 'string' ? `errors.${code}` : null;
          toast.error(key && t.has(key) ? t(key) : t('unknownError'));
        }
      } catch {
        toast.error(t('networkError'));
      } finally {
        setExecuting(false);
        setProgress(null);
      }
    },
    [selectedIds, count, overCap, onClear, router, t],
  );

  // H7: keep dialog open (with pending spinner) while archive is in-flight
  // so the admin gets visual feedback that the action was accepted and is
  // running. The dialog closes on completion (success or error).
  const handleArchiveConfirm = useCallback(async () => {
    await executeBulk('archive');
    setArchiveDialogOpen(false);
  }, [executeBulk]);

  if (count === 0) return null;

  return (
    <>
      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur-sm shadow-lg"
        style={{ scrollMarginBottom: '80px' }}
        role="toolbar"
        aria-label={t('toolbarLabel')}
      >
        {/* `flex-wrap` on BOTH rows (Task 15 review, UX-5). `Button` carries
            `whitespace-nowrap`, and the three action labels are long in every
            locale (EN "Enrol in auto-invoicing" / SV "Anmäl till
            autofakturering" / TH "เปิดใช้ใบแจ้งหนี้อัตโนมัติ"), so without
            wrapping the bar's min-content width far exceeds the 320px floor in
            ux-standards.md § 14 and the buttons overflow the viewport.
            NOTE: layout-responsive.spec.ts does not cover /admin/members and
            never selects rows, so this bar never renders there — the sweep
            cannot catch a regression here. */}
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3">
          {/* Left: selection count */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium" aria-live="polite">
              {t('selectedCount', { count })}
            </span>
            {overCap && (
              <div className="flex flex-col gap-0.5" role="alert">
                <span className="text-xs font-medium text-destructive">
                  {t('overCap', { max: BULK_CAP })}
                </span>
                {/* I2 round-10 ui-design-specialist — surface concrete
                    split guidance ("X of Y selected — deselect past row
                    Z, or filter the list") instead of just a "Maximum
                    100" error. Admins need the next step, not just the
                    constraint. */}
                <span className="text-xs text-muted-foreground">
                  {t('overCapHelper', {
                    count,
                    total: totalMatching,
                    max: BULK_CAP,
                  })}
                </span>
              </div>
            )}
          </div>

          {/* Center: action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={executing || overCap}
              onClick={(e) => {
                lastTriggerRef.current = e.currentTarget;
                setArchiveDialogOpen(true);
              }}
              className="min-h-11"
            >
              <ArchiveIcon className="mr-1.5 h-4 w-4" />
              {t('actions.archive')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={executing || overCap}
              onClick={(e) => {
                lastTriggerRef.current = e.currentTarget;
                setInviteDialogOpen(true);
              }}
              className="min-h-11"
            >
              <MailIcon className="mr-1.5 h-4 w-4" />
              {t('actions.send_portal_invite')}
            </Button>
            {/* 107-auto-invoice Task 15 — non-destructive (it only turns ON a
                billing preference and has no un-enrol counterpart yet), so
                `variant="outline"` + the generic ConfirmationDialog, matching
                the invite button rather than the destructive archive one. */}
            <Button
              variant="outline"
              size="sm"
              disabled={executing || overCap}
              onClick={(e) => {
                lastTriggerRef.current = e.currentTarget;
                setEnrolDialogOpen(true);
              }}
              className="min-h-11"
            >
              {/* FileTextIcon, NOT ReceiptTextIcon: this action drafts an
                  INVOICE (ใบแจ้งหนี้), and invoice/receipt/tax-invoice are
                  legally distinct documents in Thai tax law — an icon that
                  reads "receipt" on an invoice action is a real hazard here.
                  ReceiptTextIcon appears nowhere else in the codebase. */}
              <FileTextIcon className="mr-1.5 h-4 w-4" />
              {t('actions.enrol_auto_invoice')}
            </Button>
          </div>

          {/* Right: clear */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="min-h-11"
          >
            <XIcon className="mr-1 h-4 w-4" />
            {t('clear')}
          </Button>
        </div>
      </div>

      {/* Spacer to prevent content from being hidden behind sticky bar */}
      <div className="h-16" aria-hidden="true" />

      <ArchiveConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        companyNames={selectedCompanyNames}
        count={count}
        onConfirm={handleArchiveConfirm}
        pending={executing}
        finalFocus={finalFocus}
      />

      <ConfirmationDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        title={t('confirmInviteTitle', { count })}
        description={t('confirmInviteDescription')}
        confirmLabel={t('confirmInviteAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={() => executeBulk('send_portal_invite')}
        finalFocus={finalFocus}
      />

      <ConfirmationDialog
        open={enrolDialogOpen}
        onOpenChange={setEnrolDialogOpen}
        title={t('confirmEnrolTitle', { count })}
        description={t('confirmEnrolDescription')}
        confirmLabel={t('confirmEnrolAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={() => executeBulk('enrol_auto_invoice')}
        finalFocus={finalFocus}
      />

      {progress && (
        <BulkProgressIndicator
          action={progress.action}
          total={progress.total}
        />
      )}
    </>
  );
}
