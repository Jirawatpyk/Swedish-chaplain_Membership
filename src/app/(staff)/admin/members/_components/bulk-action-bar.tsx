'use client';

/**
 * T109 — Bulk action bar (US4 FR-018/040).
 *
 * 122 US5a (T504) — AURA `ActionBar`: sticky, in the page flow right after the
 * members table, so it floats over the list while the table is on screen and
 * takes its own space at the end (no spacer). It stays mounted with nothing
 * selected — hidden, but its live region stays, so the next selection is
 * announced. Shows "N selected" + the actions + Clear. The page's scroll
 * padding tracks its height so a focused row is never hidden behind it
 * (ADOPT-01 / WCAG 2.2 SC 2.4.11).
 *
 * Cap enforcement: if > 100 rows are selected, the action buttons are
 * disabled with a message instructing the admin to split the operation.
 *
 * Focus-on-close (107-auto-invoice Task 15 review, UX-1). EVERY successful
 * bulk action removes this bar from the DOM: `executeBulk` calls
 * `onClear()` → the parent clears `selectedIds` → `count === 0` → this
 * component renders `null`. All FOUR trigger buttons vanish, and Base UI's
 * default focus-return (the original trigger) drops focus to `<body>` — a
 * keyboard or screen-reader user must re-Tab from the top of the page after
 * every bulk action. Fixed with ONE shared `finalFocus` for all four dialogs,
 * built from `useDialogFinalFocus` (REUSED verbatim from
 * `@/components/broadcast/reason-confirmation-dialog`, same as
 * `auto-renewal-queue-actions.tsx` — not reimplemented).
 *
 * `lastTriggerRef` records whichever button opened the dialog (only one can
 * be open at a time). `closedViaSuccessRef` answers "how did THIS dialog
 * close": it is reset to `false` in each trigger's onClick, and raised in
 * `executeBulk` just before `onClear()`. On a successful close the resolver
 * skips the about-to-vanish trigger and lands on the `#main-content`
 * landmark; on Cancel / ESC / a failed action it stays `false` and focus
 * returns to the trigger. WCAG 2.1 AA SC 2.4.3.
 *
 * The reset MUST live in the onClick, not at the top of `executeBulk`
 * (re-review N1). This component returns `null` when nothing is selected,
 * but the PARENT renders it as `{isAdmin && <BulkActionBar/>}` with a
 * constant `isAdmin` — so returning `null` does NOT unmount the fiber and
 * every ref survives. Resetting only in `executeBulk` left the flag stuck
 * `true` after the first successful action (Cancel/ESC never call
 * `executeBulk`), and the next ESC threw focus to the landmark instead of
 * the still-alive trigger. Resetting on open covers open→cancel,
 * open→fail and open→succeed in one place.
 *
 * The trigger DOM node is still removed on success (the idle ActionBar renders
 * no actions), which is why the success path needs the landmark fallback at
 * all — fiber alive, DOM node gone.
 *
 * This was pre-existing on Archive and Send-invite; Task 15 added the third
 * case and fixed all three together; Task 18 adds the fourth (un-enrol) to
 * the same shared mechanism rather than growing a second one.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useFixedBarScrollPadding } from '@/hooks/use-fixed-bar-scroll-padding';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ActionBar, AuraProvider, Button } from '@jirawatpyk/aura-react';
import { ArchiveIcon, BellIcon, FileTextIcon, FileMinusIcon, MailIcon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { ArchiveConfirmDialog } from './archive-confirm-dialog';
import { BulkProgressIndicator } from './bulk-progress-indicator';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { bulkErrorKey, type BulkErrorBody } from './bulk-error-key';
import { BULK_CAP } from '@/lib/members-bulk-constants';

// I9 round-10 ui-design-specialist — `change_plan` was declared but
// never surfaced as a button (only Archive + Send-Portal-Invite render
// below). Dropped from the union so a future refactor can't fork to
// dead code; if reintroduced, add both the button AND the union entry
// in the same diff. The i18n string `admin.members.bulk.actions.change_plan`
// is preserved for if/when the button lands.
type BulkAction =
  | 'archive'
  | 'send_portal_invite'
  | 'enrol_auto_invoice'
  | 'unenrol_auto_invoice'
  | 'send_renewal_reminder';

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
  const [unenrolDialogOpen, setUnenrolDialogOpen] = useState(false);
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{
    action: string;
    total: number;
  } | null>(null);

  const count = selectedIds.length;
  const visible = count > 0;
  // Defensive only — currently UNREACHABLE: the effective selection is either the
  // page (≤ PAGE_SIZE 50) or the select-all-matching set (capped at BULK_CAP by
  // /api/members/ids), so `count` can't exceed BULK_CAP today, and the server
  // (route + bulkAction use-case) enforces the real cap regardless. Kept as a
  // cheap client guard in case a future selection path lifts the client-side cap.
  const overCap = count > BULK_CAP;

  // Focus-on-close (see module header). One ref pair serves all four
  // dialogs — only one can be open at a time, and every successful action
  // removes all four triggers from the DOM together. These refs SURVIVE
  // that: rendering `null` does not unmount the fiber (the parent's
  // `{isAdmin && …}` guard is constant), which is exactly why
  // `closedViaSuccessRef` has to be reset on dialog OPEN.
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useDialogFinalFocus(
    lastTriggerRef,
    undefined,
    closedViaSuccessRef,
  );

  // The bar's measured height feeds the page's scroll padding below, so a
  // focused row scrolls into view ABOVE the sticky bar. Measured rather than
  // guessed: the height depends on wrapping, locale label lengths and whether
  // the over-cap warning is showing.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(64);

  useEffect(() => {
    const el = barRef.current;
    if (!el || !visible) return;
    // Guard for jsdom/older browsers: without ResizeObserver keep the last
    // measured value rather than collapsing to 0.
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

  // WCAG 2.2 SC 2.4.11 — keep focus / scroll-into-view above the bar.
  useFixedBarScrollPadding(visible, barHeight);

  // Undo for a bulk archive — restores exactly the ids the archive returned via
  // the `unarchive` bulk action (domain `undelete`, 90-day window). Slim by
  // design: no confirm dialog, no selection changes (the selection was already
  // cleared), just restore + a confirmation toast + refresh. Wired to the
  // archive success toast's action button below.
  const undoArchive = useCallback(
    async (ids: string[]) => {
      try {
        const res = await fetch('/api/members/bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ action: 'unarchive', member_ids: ids }),
        });
        const body = await res.json();
        if (res.ok) {
          toast.success(
            t('unarchiveSuccess', { count: body.updated_count ?? ids.length }),
          );
          router.refresh();
        } else if (res.status === 429) {
          toast.error(t('rateLimited'));
        } else {
          const key = bulkErrorKey(body as BulkErrorBody, (k) => t.has(k));
          toast.error(key ? t(key) : t('unknownError'));
        }
      } catch {
        toast.error(t('networkError'));
      }
    },
    [router, t],
  );

  const executeBulk = useCallback(
    async (action: BulkAction, params?: Record<string, unknown>) => {
      if (overCap) return;
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
            const c = body.counts ?? { invited: 0, resent: 0, skipped: 0, failed: 0 };
            const parts = [t('inviteQueued', { invited: c.invited })];
            // Re-sent = a fresh token minted for a member whose previous
            // invitation expired. Named separately so the admin can tell it
            // apart from a first-time invite.
            if (c.resent > 0) parts.push(t('inviteResent', { resent: c.resent }));
            if (c.skipped > 0) parts.push(t('inviteSkipped', { skipped: c.skipped }));
            if (c.failed > 0) parts.push(t('inviteFailed', { failed: c.failed }));
            const message = parts.join(' · ');
            // Only a green success when at least one invite was actually queued
            // OR re-sent. If every member was skipped (e.g. all already linked
            // → invited=0, resent=0, failed=0) nothing was done, so use a
            // neutral info toast — a success tick on a no-op misleads the admin
            // into thinking invites were sent.
            if (c.failed > 0) toast.error(message);
            else if (c.invited > 0 || c.resent > 0) toast.success(message);
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
              skipped_erased: 0,
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
            // Reported separately from `skipped_terminated`: an erased member
            // can never be enrolled, whereas a terminated one can after
            // renewing. Folding them would tell the admin to retry later on a
            // member for whom that is not a legal option.
            if (c.skipped_erased > 0) {
              parts.push(t('enrolSkippedErased', { skipped: c.skipped_erased }));
            }
            const message = parts.join(' · ');
            // A no-op (everyone already enrolled / terminated) gets a neutral
            // info toast — a green tick on zero writes misleads the admin into
            // thinking the roster changed.
            if (c.enrolled > 0) toast.success(message);
            else toast.info(message);
          } else if (action === 'unenrol_auto_invoice') {
            // Two buckets, not three: un-enrol applies no membership-state
            // gate, so the only skip is "was not enrolled". Defaulted for the
            // same reason as the enrol arm — an `undefined` reaching an ICU
            // `{unenrolled, plural, …}` throws FORMATTING_ERROR inside the
            // toast call and silently eats the entire confirmation.
            const c = { unenrolled: 0, skipped_not_enrolled: 0, ...(body ?? {}) };
            const parts = [t('unenrolSucceeded', { unenrolled: c.unenrolled })];
            if (c.skipped_not_enrolled > 0) {
              parts.push(
                t('unenrolSkippedNotEnrolled', {
                  skipped: c.skipped_not_enrolled,
                }),
              );
            }
            const message = parts.join(' · ');
            if (c.unenrolled > 0) toast.success(message);
            else toast.info(message);
          } else if (action === 'send_renewal_reminder') {
            // #4 — per-member buckets (sent / skipped / failed). Members with no
            // active cycle, no step due, or opted out are SKIPPED (no email).
            // Error toast only when at least one genuinely failed; info (not a
            // green tick) when nothing was sent so a no-op never reads as success.
            const c = body.counts ?? { sent: 0, skipped: 0, failed: 0 };
            const parts = [t('reminderSent', { sent: c.sent })];
            if (c.skipped > 0)
              parts.push(t('reminderSkipped', { skipped: c.skipped }));
            if (c.failed > 0) parts.push(t('reminderFailed', { failed: c.failed }));
            const message = parts.join(' · ');
            if (c.failed > 0) toast.error(message);
            else if (c.sent > 0) toast.success(message);
            else toast.info(message);
          } else {
            const canUndo =
              action === 'archive' &&
              Array.isArray(body.updated_ids) &&
              body.updated_ids.length > 0;
            toast.success(
              t('success', {
                count: body.updated_count,
                action: t(`actions.${action}`),
              }),
              // 10-second Undo on bulk archive (ux-patterns §2.3) — restores the
              // exact ids the server just archived. Complementary to the confirm
              // dialog, which stays for accident-prevention on the way in.
              canUndo
                ? {
                    duration: 10_000,
                    action: {
                      label: t('undo'),
                      onClick: () =>
                        undoArchive(body.updated_ids as string[]),
                    },
                  }
                : undefined,
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
          const key = bulkErrorKey(body as BulkErrorBody, (k) => t.has(k));
          toast.error(key ? t(key) : t('unknownError'));
        }
      } catch {
        toast.error(t('networkError'));
      } finally {
        setExecuting(false);
        setProgress(null);
      }
    },
    [selectedIds, count, overCap, onClear, router, t, undoArchive],
  );

  // H7: the dialog stays open (confirm spinner) while the archive is in
  // flight, so the admin sees it was accepted; ConfirmationDialog closes it on
  // completion (success or error).
  const handleArchiveConfirm = useCallback(async () => {
    await executeBulk('archive');
  }, [executeBulk]);

  // Clear empties the selection, so the bar's buttons go and the focused Clear
  // button with them. AURA's ActionBar returns focus to where it came from
  // when it can (its own timer runs first); if focus is still lost after
  // that, hand it to the members table's select-all header cell (it survives
  // the clear, and as a grid cell the arrow keys work from it), else the
  // `#main-content` landmark. Only the explicit Clear moves
  // focus: a bulk action's own clear leaves focus to its dialog's
  // `finalFocus`. The E-Blast queue's bar does the same
  // (`queue-bulk-action-bar.tsx`, T086a V2).
  const handleClearSelection = useCallback(() => {
    onClear();
    setTimeout(() => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const selectAll = document.querySelector<HTMLElement>('[data-members-table] [data-rc="0:0"]');
        selectAll?.focus();
        if (selectAll === null || document.activeElement !== selectAll) {
          document.getElementById('main-content')?.focus({ preventScroll: true });
        }
      }, 0);
    }, 0);
  }, [onClear]);

  // The ActionBar's own count and Clear, in this bar's words.
  const barStrings = useMemo(
    () => ({
      selectedCount: (n: number) => t('selectedCount', { count: n }),
      clear: () => t('clear'),
    }),
    [t],
  );

  return (
    <>
      <AuraProvider strings={barStrings}>
        <ActionBar
          ref={barRef}
          label={t('toolbarLabel')}
          selected={count}
          onClearSelection={handleClearSelection}
          status={
            overCap ? (
              <span className="flex flex-col gap-0.5" role="alert">
                <span className="text-xs font-medium text-[var(--aura-fg-danger)]">
                  {t('overCap', { max: BULK_CAP })}
                </span>
                {/* I2 round-10 ui-design-specialist — concrete split guidance
                    ("X of Y selected — deselect past row Z, or filter the
                    list"), not just the "Maximum 100" constraint. */}
                <span className="text-xs text-[var(--aura-fg-secondary)]">
                  {t('overCapHelper', { count, total: totalMatching, max: BULK_CAP })}
                </span>
              </span>
            ) : undefined
          }
        >
          {/* The triggers are NOT disabled while an action runs: its modal
              dialog already blocks the bar, and a disabled trigger cannot take
              focus back when a FAILED action closes its dialog (SC 2.4.3). */}
          {visible && (
            <>
              <Button
                variant="danger-secondary"
                size="sm"
                icon={<ArchiveIcon aria-hidden="true" />}
                disabled={overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  // "How did THIS dialog close" — reset on OPEN so Cancel/ESC
                  // after an earlier SUCCESS still returns focus to the
                  // trigger. The fiber (and this ref) survives the idle bar.
                  closedViaSuccessRef.current = false;
                  setArchiveDialogOpen(true);
                }}
              >
                {t('actions.archive')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<MailIcon aria-hidden="true" />}
                disabled={overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setInviteDialogOpen(true);
                }}
              >
                {t('actions.send_portal_invite')}
              </Button>
              {/* 107-auto-invoice Task 15 — non-destructive (it only turns ON
                  a billing preference), so a secondary button + the generic
                  ConfirmationDialog, like the invite button.
                  FileTextIcon, NOT a receipt icon: this action drafts an
                  INVOICE (ใบแจ้งหนี้), and invoice/receipt/tax-invoice are
                  legally distinct documents in Thai tax law. */}
              <Button
                variant="secondary"
                size="sm"
                icon={<FileTextIcon aria-hidden="true" />}
                disabled={overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setEnrolDialogOpen(true);
                }}
              >
                {t('actions.enrol_auto_invoice')}
              </Button>
              {/* 107-auto-invoice Task 18 — the off switch for the button
                  above. Not destructive: it destroys no data and issues no
                  document; it only stops FUTURE drafts being prepared. */}
              <Button
                variant="secondary"
                size="sm"
                icon={<FileMinusIcon aria-hidden="true" />}
                disabled={overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setUnenrolDialogOpen(true);
                }}
              >
                {t('actions.unenrol_auto_invoice')}
              </Button>
              {/* #4 members-ux — send a renewal reminder (best-effort per
                  member), on the same finalFocus refs as the other four. */}
              <Button
                variant="secondary"
                size="sm"
                icon={<BellIcon aria-hidden="true" />}
                disabled={overCap}
                onClick={(e) => {
                  lastTriggerRef.current = e.currentTarget;
                  closedViaSuccessRef.current = false;
                  setReminderDialogOpen(true);
                }}
              >
                {t('actions.send_renewal_reminder')}
              </Button>
            </>
          )}
        </ActionBar>
      </AuraProvider>

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

      <ConfirmationDialog
        open={unenrolDialogOpen}
        onOpenChange={setUnenrolDialogOpen}
        title={t('confirmUnenrolTitle', { count })}
        description={t('confirmUnenrolDescription')}
        confirmLabel={t('confirmUnenrolAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={() => executeBulk('unenrol_auto_invoice')}
        finalFocus={finalFocus}
      />

      <ConfirmationDialog
        open={reminderDialogOpen}
        onOpenChange={setReminderDialogOpen}
        title={t('confirmReminderTitle', { count })}
        description={t('confirmReminderDescription')}
        confirmLabel={t('confirmReminderAction')}
        cancelLabel={t('cancel')}
        confirmDisabled={executing}
        onConfirm={() => executeBulk('send_renewal_reminder')}
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
