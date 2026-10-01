/**
 * DV-5 — `CycleAdminActions`.
 *
 * Admin cancel-cycle + mark-paid-offline actions on the cycle-detail page,
 * mirroring the dialog/fetch/`readErrorCode`/toast/`router.refresh()` shape of
 * `pending-reactivation-actions.tsx`. The backend (use-cases + routes) already
 * ships; this is the missing UI affordance.
 *
 * Per-control visibility gates (a control renders ONLY when the cycle is in a
 * status where the action is valid — matching the route's state-machine
 * guards, so we never present an affordance that the API will reject):
 *   - Cancel:           upcoming | reminded | awaiting_payment
 *   - Mark paid offline: upcoming | awaiting_payment with NO live linked
 *     bill (via the shared `shouldOfferMarkPaid` gate — `_lib/mark-paid-gate.ts`)
 *   - Record payment on {bill}: upcoming | awaiting_payment WITH a live linked
 *     bill — a primary link to that invoice's F4 Record payment flow, in
 *     place of mark-paid (which the use-case would refuse with
 *     `membership_bill_already_exists`).
 *   - Neither:          completed | lapsed | cancelled | pending_admin_reactivation
 *     (a pending_admin_reactivation cycle has its own approve/reject actions in
 *      `pending-reactivation-actions.tsx`).
 *
 * 122 US7b-1 (T722), board `Admin-renewal-cycle` (+ `-mobile`): the actions
 * sit in the page header on AURA — the payment action primary, Cancel cycle in
 * the danger style. On a phone Cancel cycle leaves the header for the danger
 * zone at the end of the page (`placement="dangerZone"`). The cancel confirm
 * is an AURA alertdialog; its reason, request, toasts and refresh are
 * unchanged.
 *
 * Cancel is destructive (AlertDialog + required reason 1..500). Mark-paid
 * (DV-Wave2 ⑤) is a controlled `MarkPaidOfflineDialog` — extracted so the
 * pipeline table's ⋯ row menu can reuse the SAME dialog/route as a modal
 * action, rather than a second settlement/mutation path. This component owns
 * only the open/close toggle + trigger Button for it. WCAG 2.1 AA: labelled
 * controls, focus-on-Cancel default, submit disabled while pending, error
 * codes surfaced as toasts.
 */
'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BanknoteIcon } from 'lucide-react';
import { Button, Dialog, Textarea, buttonClass } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import type { CycleStatus } from '@/modules/renewals';
import { MarkPaidOfflineDialog } from '../../_components/mark-paid-offline-dialog';
import {
  shouldOfferMarkPaid,
  shouldOfferRecordPaymentOnBill,
} from '../../_lib/mark-paid-gate';
import {
  isCancelReasonInvalid,
  isCycleCancellable,
  REASON_MAX,
} from './cycle-admin-validation';


export interface CycleAdminActionsProps {
  readonly cycleId: string;
  readonly status: CycleStatus;
  /**
   * The cycle's linked bill when it is still live (not void), else null.
   * `billNumber` is the printed number (SC-… / §86/4), null when unknown
   * (a degraded F4 fetch) — the link label then falls back to generic copy.
   */
  readonly liveLinkedBill: {
    readonly invoiceId: string;
    readonly billNumber: string | null;
  } | null;
  /**
   * `header` (default): every control, Cancel cycle hidden below 640px.
   * `dangerZone`: Cancel cycle alone, full width, for the phone's end-of-page
   * danger zone (board `Admin-renewal-cycle-mobile`).
   */
  readonly placement?: 'header' | 'dangerZone';
}

/**
 * Read `error.code` (+ optional invoice-id details) off a non-2xx JSON body.
 * The route envelope is `{ error: { code, ...details } }`, so
 * `orphan_invoice_id` / `existing_invoice_id` live directly on the `error`
 * object. Falls back to server_error on a malformed body.
 */
async function readError(res: Response): Promise<{
  code: string;
  orphan_invoice_id?: string;
  existing_invoice_id?: string;
}> {
  try {
    const body = (await res.json()) as {
      error?: {
        code?: string;
        orphan_invoice_id?: string;
        existing_invoice_id?: string;
      };
    };
    return {
      code: body.error?.code ?? 'server_error',
      ...(body.error?.orphan_invoice_id !== undefined
        ? { orphan_invoice_id: body.error.orphan_invoice_id }
        : {}),
      ...(body.error?.existing_invoice_id !== undefined
        ? { existing_invoice_id: body.error.existing_invoice_id }
        : {}),
    };
  } catch {
    return { code: 'server_error' };
  }
}

export function CycleAdminActions({
  cycleId,
  status,
  liveLinkedBill,
  placement = 'header',
}: CycleAdminActionsProps) {
  const t = useTranslations('admin.renewals.cycleDetail');
  const router = useRouter();

  // --- Cancel state ---
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelPending, startCancel] = useTransition();

  // --- Mark-paid-offline state --- (dialog body itself lives in the
  // extracted `MarkPaidOfflineDialog` — see `_components/mark-paid-offline-
  // dialog.tsx`; this component only owns the open/close toggle + trigger
  // button, same shape as the cancel AlertDialog above).
  const [markPaidOpen, setMarkPaidOpen] = useState(false);

  const inDangerZone = placement === 'dangerZone';
  const showCancel = isCycleCancellable(status);
  const linkedInvoiceId = liveLinkedBill?.invoiceId ?? null;
  // The danger zone holds Cancel cycle only; the payment action stays in the
  // header at every width.
  const showMarkPaid = !inDangerZone && shouldOfferMarkPaid(status, linkedInvoiceId);
  const showRecordPayment =
    !inDangerZone && shouldOfferRecordPaymentOnBill(status, linkedInvoiceId);

  // Render nothing for cycles where no action is valid (terminal +
  // pending_admin_reactivation, which has its own approve/reject component).
  if (!showCancel && !showMarkPaid && !showRecordPayment) {
    return null;
  }

  const trimmedReason = reason.trim();
  const reasonInvalid = isCancelReasonInvalid(reason);

  const onCancel = () => {
    if (reasonInvalid) return;
    startCancel(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: trimmedReason }),
          },
        );
        if (!res.ok) {
          const err = await readError(res);
          if (err.code === 'cycle_not_cancellable') {
            // The cycle changed under us (e.g. another admin marked it paid):
            // show why, then close + refresh so the now-invalid action
            // disappears instead of inviting a doomed re-submit.
            toast.error(t('cancelCycle.error.cycle_not_cancellable'));
            setCancelOpen(false);
            setReason('');
            router.refresh();
            return;
          }
          const key = `cancelCycle.error.${err.code}`;
          toast.error(t.has(key) ? t(key) : t('cancelCycle.error.server_error'));
          return;
        }
        toast.success(t('cancelCycle.successToast'));
        setCancelOpen(false);
        setReason('');
        router.refresh();
      } catch {
        toast.error(t('cancelCycle.error.server_error'));
      }
    });
  };

  const closeCancel = () => {
    // Clear the reason on close so a reopened dialog never pre-fills a stale
    // justification onto the cancel audit trail.
    setCancelOpen(false);
    setReason('');
  };

  return (
    <>
      {/* --- Record payment on the live linked bill (F4 flow) --- */}
      {showRecordPayment && liveLinkedBill !== null && (
        <Link
          href={`/admin/invoices/${encodeURIComponent(liveLinkedBill.invoiceId)}`}
          className={buttonClass({ variant: 'primary' })}
        >
          <BanknoteIcon aria-hidden="true" className="size-4" />
          {liveLinkedBill.billNumber !== null
            ? t('recordPaymentOnBill.link', {
                billNumber: liveLinkedBill.billNumber,
              })
            : t('recordPaymentOnBill.linkNoNumber')}
        </Link>
      )}

      {/* --- Mark paid offline (the board's primary action) --- */}
      {showMarkPaid && (
        <>
          <Button
            variant="primary"
            icon={<BanknoteIcon aria-hidden="true" className="size-4" />}
            onClick={() => setMarkPaidOpen(true)}
          >
            {t('markPaidOffline.button')}
          </Button>
          {/* No `finalFocus` passed — this trigger does not unmount on this
              page, so the default restore-focus is the right target. */}
          <MarkPaidOfflineDialog
            cycleId={cycleId}
            open={markPaidOpen}
            onOpenChange={setMarkPaidOpen}
          />
        </>
      )}

      {/* --- Cancel cycle (destructive) --- */}
      {showCancel && (
        <>
          <Button
            variant="danger-secondary"
            icon="ban"
            className={inDangerZone ? 'w-full' : 'max-sm:hidden'}
            onClick={() => setCancelOpen(true)}
          >
            {t('cancelCycle.button')}
          </Button>
          <Dialog
            open={cancelOpen}
            onClose={closeCancel}
            role="alertdialog"
            // ux-standards § 6.4: no dismissal while the cancel is in flight.
            dismissible={!cancelPending}
            title={t('cancelCycle.dialogTitle')}
            description={t('cancelCycle.dialogBody')}
            // Focus on Cancel by default (ux-standards § 4).
            footer={
              <>
                <Button
                  variant="secondary"
                  data-autofocus=""
                  onClick={closeCancel}
                  disabled={cancelPending}
                >
                  {t('cancelCycle.cancel')}
                </Button>
                <Button
                  variant="danger"
                  onClick={onCancel}
                  loading={cancelPending}
                  disabled={reasonInvalid}
                >
                  {cancelPending ? t('cancelCycle.submitting') : t('cancelCycle.confirm')}
                </Button>
              </>
            }
          >
            <Textarea
              label={t('cancelCycle.reasonLabel')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('cancelCycle.reasonPlaceholder')}
              rows={3}
              maxLength={REASON_MAX}
              required
              {...(reasonInvalid && reason.length > 0
                ? { error: t('cancelCycle.reasonRequired') }
                : { hint: t('cancelCycle.reasonRequired') })}
            />
          </Dialog>
        </>
      )}
    </>
  );
}
