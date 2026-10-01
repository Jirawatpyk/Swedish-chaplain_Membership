/**
 * 070 F8 item #18 — `PendingReactivationActions`.
 *
 * Admin approve / reject-with-refund actions for a cycle stuck in
 * `pending_admin_reactivation`. Renders NOTHING unless the cycle is in
 * that state (a cycle in any other status has no pending decision).
 *
 * UX-A Bug 2: also renders NOTHING when the cycle carries the async
 * reject-with-refund marker (`rejectRefundInitiatedAt !== null`). Such a
 * cycle has ALREADY been rejected — the refund is settling and the reconcile
 * cron will converge it to `cancelled` — so offering Approve/Reject overstates
 * open work AND (for Approve) would hit the 409 `reject_refund_in_progress`
 * guard. The page renders a distinct "refund settling" notice instead. This
 * component-level gate is belt-and-suspenders with the page-level gate.
 *
 * Two actions, mirroring the dialog/fetch/toast/`router.refresh()` shape
 * of `at-risk/_components/outreach-dialog.tsx`:
 *
 *   1. **Approve** — a non-destructive confirmation `Dialog` → POST
 *      `/api/admin/renewals/[cycleId]/reactivate` → toast → refresh.
 *   2. **Reject & refund** — a DESTRUCTIVE `AlertDialog` with a required
 *      reason `<Textarea>` (client-validated 1..500) + irreversible-refund
 *      copy → POST `/api/admin/renewals/[cycleId]/reject` → toast that
 *      distinguishes "refund issued" from "rejected, no payment to refund"
 *      via `refund_credit_note_id === null` → refresh.
 *
 * WCAG 2.1 AA: labelled textarea, focus-on-Cancel default (defensive for a
 * money action), submit disabled while pending or when the reason is
 * invalid, error codes surfaced as toasts.
 *
 * 122 US7b-1 (T723), board `Admin-renewal-cycle-pending`: AURA buttons in the
 * page header (Approve primary, Reject & refund danger) and AURA
 * alertdialogs; requests, toasts and refreshes are unchanged.
 */
'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Dialog, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { readErrorCode } from '../../_lib/read-error-code';

const REASON_MIN = 1;
const REASON_MAX = 500;

export interface PendingReactivationActionsProps {
  readonly cycleId: string;
  readonly status: string;
  /**
   * UX-A Bug 2 — async reject-with-refund marker (ISO 8601 UTC, migration
   * 0243). Non-null means the cycle was already rejected and its refund is
   * settling; this component then renders nothing (the decision is made).
   */
  readonly rejectRefundInitiatedAt: string | null;
  /**
   * `header` (default): Approve full width on a phone, Reject & refund hidden
   * below 640px. `dangerZone`: Reject & refund alone, full width, for the
   * phone's end-of-page danger zone — the refund never sits beside the primary
   * action on a phone (UX review M6; spec Clarifications, US7b start).
   */
  readonly placement?: 'header' | 'dangerZone';
}

interface RejectSuccessBody {
  readonly refund_credit_note_id: string | null;
}

export function PendingReactivationActions({
  cycleId,
  status,
  rejectRefundInitiatedAt,
  placement = 'header',
}: PendingReactivationActionsProps) {
  const t = useTranslations(
    'admin.renewals.cycleDetail.pendingReactivation',
  );
  const router = useRouter();

  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reactivatePending, startReactivate] = useTransition();
  const [rejectPending, startReject] = useTransition();
  // Focus return (WCAG 2.4.3): a decision refreshes the page and these
  // triggers leave it, so focus lands on `#main-content`; on Cancel / Escape
  // it returns to the trigger.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const succeededRef = useRef(false);
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: succeededRef.current,
        trigger: triggerRef.current,
        fallback: null,
        mainContent: typeof document !== 'undefined' ? document.getElementById('main-content') : null,
      }),
    [],
  );
  const open = (setter: (v: boolean) => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = e.currentTarget;
    succeededRef.current = false;
    setter(true);
  };

  // Render nothing for cycles that aren't awaiting an admin decision.
  if (status !== 'pending_admin_reactivation') {
    return null;
  }
  // UX-A Bug 2: a marked (already-rejected, refund-settling) cycle has no
  // remaining decision — hide both actions. The page renders the
  // "refund settling" notice instead.
  if (rejectRefundInitiatedAt !== null) {
    return null;
  }

  const trimmedReason = reason.trim();
  const reasonInvalid =
    trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX;

  const onReactivate = () => {
    startReactivate(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/reactivate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        );
        if (!res.ok) {
          // UX-A Bug 2: a 409 `reject_refund_in_progress` means the cycle was
          // rejected (async refund in flight) between page render and this
          // click — surface the specific reason and refresh so the page
          // re-renders into the settling state (the Approve button disappears).
          const code = await readErrorCode(res);
          if (code === 'reject_refund_in_progress') {
            toast.error(t('reactivate.errorRefundInProgressToast'));
            setReactivateOpen(false);
            router.refresh();
            return;
          }
          toast.error(t('reactivate.errorToast'));
          return;
        }
        toast.success(t('reactivate.successToast'));
        succeededRef.current = true;
        setReactivateOpen(false);
        router.refresh();
      } catch {
        toast.error(t('reactivate.errorToast'));
      }
    });
  };

  const onReject = () => {
    if (reasonInvalid) return;
    startReject(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/reject`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: trimmedReason }),
          },
        );
        if (!res.ok) {
          const code = await readErrorCode(res);
          const key = `reject.error.${code}`;
          toast.error(
            t.has(key) ? t(key) : t('reject.error.server_error'),
          );
          return;
        }
        // F8-RP: a 202 means the F5 refund is settling ASYNCHRONOUSLY — the
        // cycle intentionally stays in the pending list until the refund
        // confirms. Handle it BEFORE parsing the 200 body: the 202 has no
        // `refund_credit_note_id`, so the default parse would wrongly render
        // the "no payment to refund" toast for an in-flight refund.
        if (res.status === 202) {
          toast.success(t('reject.successPendingToast'));
          succeededRef.current = true;
          setRejectOpen(false);
          setReason('');
          router.refresh();
          return;
        }
        const body = (await res.json()) as RejectSuccessBody;
        toast.success(
          body.refund_credit_note_id === null
            ? t('reject.successNoRefundToast')
            : t('reject.successRefundedToast'),
        );
        succeededRef.current = true;
        setRejectOpen(false);
        setReason('');
        router.refresh();
      } catch {
        toast.error(t('reject.error.server_error'));
      }
    });
  };

  const closeReject = () => {
    // Clear the reason on close so a reopened dialog never pre-fills a stale
    // justification onto the refund audit trail.
    setRejectOpen(false);
    setReason('');
  };

  return (
    <>
      {/* --- Approve (the board's primary action; full width on a phone) --- */}
      {placement === 'header' && (
        <Button variant="primary" className="max-sm:w-full" onClick={open(setReactivateOpen)}>
          {t('reactivate.button')}
        </Button>
      )}
      <Dialog
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        role="alertdialog"
        dismissible={!reactivatePending}
        finalFocus={finalFocus}
        title={t('reactivate.dialogTitle')}
        description={t('reactivate.dialogBody')}
        // Focus on Cancel by default (defensive for a money action).
        footer={
          <>
            <Button
              variant="secondary"
              data-autofocus=""
              onClick={() => setReactivateOpen(false)}
              disabled={reactivatePending}
            >
              {t('reactivate.cancel')}
            </Button>
            <Button onClick={onReactivate} loading={reactivatePending}>
              {reactivatePending ? t('reactivate.submitting') : t('reactivate.confirm')}
            </Button>
          </>
        }
      />

      {/* --- Reject & refund (destructive) --- */}
      <Button
        variant="danger-secondary"
        icon="rotate-ccw"
        className={placement === 'dangerZone' ? 'w-full' : 'max-sm:hidden'}
        onClick={open(setRejectOpen)}
      >
        {t('reject.button')}
      </Button>
      <Dialog
        open={rejectOpen}
        onClose={closeReject}
        role="alertdialog"
        dismissible={!rejectPending}
        finalFocus={finalFocus}
        title={t('reject.dialogTitle')}
        description={t('reject.dialogBody')}
        footer={
          <>
            <Button variant="secondary" data-autofocus="" onClick={closeReject} disabled={rejectPending}>
              {t('reject.cancel')}
            </Button>
            <Button variant="danger" onClick={onReject} loading={rejectPending} disabled={reasonInvalid}>
              {rejectPending ? t('reject.submitting') : t('reject.confirm')}
            </Button>
          </>
        }
      >
        <Textarea
          label={t('reject.reasonLabel')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reject.reasonPlaceholder')}
          rows={3}
          maxLength={REASON_MAX}
          readOnly={rejectPending}
          required
          {...(reasonInvalid && reason.length > 0
            ? { error: t('reject.reasonRequired') }
            : { hint: t('reject.reasonRequired') })}
        />
      </Dialog>
    </>
  );
}
