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
 *   - Mark paid offline: upcoming | awaiting_payment
 *   - Neither:          completed | lapsed | cancelled | pending_admin_reactivation
 *     (a pending_admin_reactivation cycle has its own approve/reject actions in
 *      `pending-reactivation-actions.tsx`).
 *
 * Cancel is destructive (AlertDialog + required reason 1..500). Mark-paid is a
 * plain Dialog with three required fields; the confirm button stays disabled
 * until all three are filled. WCAG 2.1 AA: labelled controls, focus-on-Cancel
 * default, submit disabled while pending, error codes surfaced as toasts.
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CycleStatus } from '@/modules/renewals';
import {
  isCancelReasonInvalid,
  isMarkPaidIncomplete,
  REASON_MAX,
} from './cycle-admin-validation';
import {
  resolveExistingBillHref,
  resolveOrphanInvoiceHref,
} from './cycle-admin-error-codes';

/** Statuses where the Cancel control is offered (matches the route guard). */
const CANCELLABLE_STATUSES = new Set<CycleStatus>([
  'upcoming',
  'reminded',
  'awaiting_payment',
]);
/** Statuses where the Mark-paid-offline control is offered. */
const PAYABLE_STATUSES = new Set<CycleStatus>([
  'upcoming',
  'awaiting_payment',
]);

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

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
  const format = useFormatter();
  const router = useRouter();

  // --- Cancel state ---
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelPending, startCancel] = useTransition();
  const cancelCancelRef = useRef<HTMLButtonElement | null>(null);

  // --- Mark-paid-offline state ---
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [markPaidPending, startMarkPaid] = useTransition();
  const markPaidCancelRef = useRef<HTMLButtonElement | null>(null);

  const showCancel = CANCELLABLE_STATUSES.has(status);
  const showMarkPaid = PAYABLE_STATUSES.has(status);

  // Render nothing for cycles where neither action is valid (terminal +
  // pending_admin_reactivation, which has its own approve/reject component).
  if (!showCancel && !showMarkPaid) {
    return null;
  }

  const trimmedReason = reason.trim();
  const reasonInvalid = isCancelReasonInvalid(reason);

  const trimmedReference = paymentReference.trim();
  const markPaidIncomplete = isMarkPaidIncomplete(paymentReference, paymentDate);

  const resetMarkPaidFields = () => {
    setPaymentReference('');
    setPaymentDate('');
    setPaymentMethod('bank_transfer');
  };

  // Shared POST runner — owns the fetch + non-2xx error-toast + catch
  // envelope that is identical for both endpoints. `onSuccess` receives the
  // parsed 2xx JSON body (branch-specific copy — e.g. mark-paid's
  // 'reanchored' outcome — reads it there; cancel's onSuccess ignores it)
  // and does the toast + field reset + refresh; the optional `onError`
  // returns true when it fully handled a specific code (mark-paid's
  // f4_orphan_invoice deep-link), suppressing the generic code→toast
  // fallback.
  const runAction = async (
    endpoint: string,
    body: Record<string, unknown>,
    namespace: 'cancelCycle' | 'markPaidOffline',
    onSuccess: (data: unknown) => void,
    onError?: (err: { code: string; orphan_invoice_id?: string }) => boolean,
  ): Promise<void> => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await readError(res);
        if (onError?.(err)) return;
        const key = `${namespace}.error.${err.code}`;
        toast.error(t.has(key) ? t(key) : t(`${namespace}.error.server_error`));
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      onSuccess(data);
    } catch {
      toast.error(t(`${namespace}.error.server_error`));
    }
  };

  const onCancel = () => {
    if (reasonInvalid) return;
    startCancel(() =>
      runAction(
        `/api/admin/renewals/${encodeURIComponent(cycleId)}/cancel`,
        { reason: trimmedReason },
        'cancelCycle',
        () => {
          toast.success(t('cancelCycle.successToast'));
          setCancelOpen(false);
          setReason('');
          router.refresh();
        },
        (err) => {
          if (err.code === 'cycle_not_cancellable') {
            // The cycle changed under us (e.g. another admin marked it paid):
            // show why, then close + refresh so the now-invalid action
            // disappears instead of inviting a doomed re-submit.
            toast.error(t('cancelCycle.error.cycle_not_cancellable'));
            setCancelOpen(false);
            setReason('');
            router.refresh();
            return true;
          }
          return false;
        },
      ),
    );
  };

  const onMarkPaid = () => {
    if (markPaidIncomplete) return;
    startMarkPaid(() =>
      runAction(
        `/api/admin/renewals/${encodeURIComponent(cycleId)}/mark-paid-offline`,
        {
          payment_method: paymentMethod,
          payment_reference: trimmedReference,
          payment_date: paymentDate,
        },
        'markPaidOffline',
        (data) => {
          // FIXED-ANCHOR (2026-07-22) — the member's one-and-only cycle was
          // ACTIVATED (not completed): status stays `upcoming` and
          // `anchored_at` is stamped, but the membership PERIOD keeps its
          // registration/backfill anchor — it does NOT move to the payment
          // month (that was the reverted #173 payment-anchor bug). Distinct
          // copy so the admin understands the cycle stayed `upcoming` instead
          // of completing. The toast's `{date}` is that fixed period start.
          // (The rare comeback exception — an already-expired period at
          // payment — re-anchors to a fresh period, and `{date}` then renders
          // the new start.)
          const dataObj = data as
            | {
                outcome?: string;
                new_period_from?: string;
                email_dispatch?: string;
              }
            | null;
          // Cluster 5 (Finding 1) parity — the §86/4 renewal receipt was
          // issued but the payment-time auto-email was SKIPPED (member has no
          // contact email on file). Append a non-blocking warning line so the
          // admin knows to deliver it manually — mirroring the three invoice
          // forms (issue-invoice / payment / event-fee), which surface the
          // same `successNoEmailWarning` as a description on their success
          // toast. Only warns on 'skipped_no_email' (never 'sent'/'disabled').
          const noEmailWarning =
            dataObj?.email_dispatch === 'skipped_no_email'
              ? t('markPaidOffline.successNoEmailWarning')
              : null;
          if (dataObj?.outcome === 'reanchored' && dataObj.new_period_from) {
            toast.success(
              t('markPaidOffline.successReanchored', {
                date: format.dateTime(
                  new Date(dataObj.new_period_from),
                  'dateMedium',
                ),
              }),
              noEmailWarning ? { description: noEmailWarning } : undefined,
            );
          } else {
            toast.success(
              t('markPaidOffline.successToast'),
              noEmailWarning ? { description: noEmailWarning } : undefined,
            );
          }
          setMarkPaidOpen(false);
          resetMarkPaidFields();
          router.refresh();
        },
        (err) => {
          const orphanHref = resolveOrphanInvoiceHref(err);
          if (orphanHref) {
            // DO-NOT-RETRY: an invoice was issued but the cycle flip failed.
            // The admin must resume from the F4 invoice list — surface the
            // deep-link in the toast so they can act without a support ticket.
            toast.error(t('markPaidOffline.error.f4_orphan_invoice'), {
              action: {
                label: t('markPaidOffline.viewOrphanInvoice'),
                onClick: () => {
                  router.push(orphanHref);
                },
              },
              duration: 30_000,
            });
            return true;
          }
          const existingBillHref = resolveExistingBillHref(err);
          if (existingBillHref) {
            // A live membership bill for this plan year already exists and
            // NOTHING was minted. Point the operator at that invoice — the F4
            // record-payment dialog there runs the same on-paid callbacks, so
            // it completes this cycle and opens the next one. Then close +
            // refresh so the stale action is not re-clicked.
            toast.error(t('markPaidOffline.error.membership_bill_already_exists'), {
              action: {
                label: t('markPaidOffline.viewExistingInvoice'),
                onClick: () => {
                  router.push(existingBillHref);
                },
              },
              duration: 30_000,
            });
            setMarkPaidOpen(false);
            resetMarkPaidFields();
            router.refresh();
            return true;
          }
          if (err.code === 'cycle_not_payable') {
            // The cycle is no longer payable (another admin acted): show why,
            // then close + refresh so the stale action disappears.
            toast.error(t('markPaidOffline.error.cycle_not_payable'));
            setMarkPaidOpen(false);
            resetMarkPaidFields();
            router.refresh();
            return true;
          }
          return false;
        },
      ),
    );
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* --- Mark paid offline (non-destructive) --- */}
      {showMarkPaid && (
        <>
          <Button variant="outline" onClick={() => setMarkPaidOpen(true)}>
            {t('markPaidOffline.button')}
          </Button>
          <Dialog
            open={markPaidOpen}
            onOpenChange={(open) => {
              setMarkPaidOpen(open);
              if (!open) {
                resetMarkPaidFields();
              }
            }}
          >
            <DialogContent initialFocus={markPaidCancelRef}>
              <DialogHeader>
                <DialogTitle>{t('markPaidOffline.dialogTitle')}</DialogTitle>
                <DialogDescription>
                  {t('markPaidOffline.dialogBody')}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mark-paid-method">
                    {t('markPaidOffline.paymentMethodLabel')}
                  </Label>
                  <Select
                    value={paymentMethod}
                    onValueChange={(v) => setPaymentMethod(v as PaymentMethod)}
                  >
                    <SelectTrigger id="mark-paid-method" className="w-full">
                      <TranslatedSelectValue
                        translate={(v) =>
                          t(`markPaidOffline.paymentMethod.${v}`)
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {t(`markPaidOffline.paymentMethod.${m}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mark-paid-reference">
                    {t('markPaidOffline.paymentReferenceLabel')}
                  </Label>
                  <Input
                    id="mark-paid-reference"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder={t(
                      'markPaidOffline.paymentReferencePlaceholder',
                    )}
                    maxLength={100}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mark-paid-date">
                    {t('markPaidOffline.paymentDateLabel')}
                  </Label>
                  <Input
                    id="mark-paid-date"
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    required
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  ref={markPaidCancelRef}
                  variant="outline"
                  onClick={() => setMarkPaidOpen(false)}
                  disabled={markPaidPending}
                >
                  {t('markPaidOffline.cancel')}
                </Button>
                <Button
                  onClick={onMarkPaid}
                  disabled={markPaidPending || markPaidIncomplete}
                >
                  {markPaidPending ? (
                    <>
                      <Loader2Icon
                        className="size-4 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                      {t('markPaidOffline.submitting')}
                    </>
                  ) : (
                    t('markPaidOffline.confirm')
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
