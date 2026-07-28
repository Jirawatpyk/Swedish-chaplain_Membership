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
 *   - Mark paid offline: upcoming | awaiting_payment (via the shared
 *     `shouldOfferMarkPaid` gate — `_lib/mark-paid-gate.ts`)
 *   - Neither:          completed | lapsed | cancelled | pending_admin_reactivation
 *     (a pending_admin_reactivation cycle has its own approve/reject actions in
 *      `pending-reactivation-actions.tsx`).
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

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CycleStatus } from '@/modules/renewals';
import { MarkPaidOfflineDialog } from '../../_components/mark-paid-offline-dialog';
import { shouldOfferMarkPaid } from '../../_lib/mark-paid-gate';
import { isCancelReasonInvalid, REASON_MAX } from './cycle-admin-validation';

/** Statuses where the Cancel control is offered (matches the route guard). */
const CANCELLABLE_STATUSES = new Set<CycleStatus>([
  'upcoming',
  'reminded',
  'awaiting_payment',
]);

export interface CycleAdminActionsProps {
  readonly cycleId: string;
  readonly status: CycleStatus;
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

export function CycleAdminActions({ cycleId, status }: CycleAdminActionsProps) {
  const t = useTranslations('admin.renewals.cycleDetail');
  const router = useRouter();

  // --- Cancel state ---
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelPending, startCancel] = useTransition();
  const cancelCancelRef = useRef<HTMLButtonElement | null>(null);

  // --- Mark-paid-offline state --- (dialog body itself lives in the
  // extracted `MarkPaidOfflineDialog` — see `_components/mark-paid-offline-
  // dialog.tsx`; this component only owns the open/close toggle + trigger
  // button, same shape as the cancel AlertDialog above).
  const [markPaidOpen, setMarkPaidOpen] = useState(false);

  const showCancel = CANCELLABLE_STATUSES.has(status);
  const showMarkPaid = shouldOfferMarkPaid(status);

  // Render nothing for cycles where neither action is valid (terminal +
  // pending_admin_reactivation, which has its own approve/reject component).
  if (!showCancel && !showMarkPaid) {
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

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* --- Mark paid offline (non-destructive) --- */}
      {showMarkPaid && (
        <>
          <Button variant="outline" onClick={() => setMarkPaidOpen(true)}>
            {t('markPaidOffline.button')}
          </Button>
          {/* No `finalFocus` passed — this trigger Button does not unmount
              on this page, so Base UI's default restore-focus behaviour is
              exactly the pre-extraction shape (see the dialog's docstring). */}
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
          <Button variant="destructive" onClick={() => setCancelOpen(true)}>
            {t('cancelCycle.button')}
          </Button>
          <AlertDialog
            open={cancelOpen}
            onOpenChange={(open) => {
              setCancelOpen(open);
              // Clear the reason on cancel/close so a reopened dialog never
              // pre-fills a stale justification onto the cancel audit trail.
              if (!open) setReason('');
            }}
          >
            <AlertDialogContent initialFocus={cancelCancelRef}>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('cancelCycle.dialogTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('cancelCycle.dialogBody')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="cancel-reason">
                  {t('cancelCycle.reasonLabel')}
                </Label>
                <Textarea
                  id="cancel-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('cancelCycle.reasonPlaceholder')}
                  rows={3}
                  maxLength={REASON_MAX}
                  aria-invalid={reasonInvalid && reason.length > 0}
                  aria-describedby="cancel-reason-hint"
                  required
                />
                <p
                  id="cancel-reason-hint"
                  className={
                    'text-xs ' +
                    (reasonInvalid && reason.length > 0
                      ? 'text-destructive'
                      : 'text-muted-foreground')
                  }
                >
                  {t('cancelCycle.reasonRequired')}
                </p>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel
                  ref={cancelCancelRef}
                  disabled={cancelPending}
                >
                  {t('cancelCycle.cancel')}
                </AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={onCancel}
                  disabled={cancelPending || reasonInvalid}
                >
                  {cancelPending ? (
                    <>
                      <Loader2Icon
                        className="size-4 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                      {t('cancelCycle.submitting')}
                    </>
                  ) : (
                    t('cancelCycle.confirm')
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
