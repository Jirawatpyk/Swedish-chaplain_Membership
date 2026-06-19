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
import { useTranslations } from 'next-intl';
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

const REASON_MIN = 1;
const REASON_MAX = 500;

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

interface CancelSuccessBody {
  readonly status: string;
  readonly closed_at: string | null;
}

interface MarkPaidSuccessBody {
  readonly cycle_status: string;
  readonly invoice_id: string;
  readonly new_expires_at: string;
}

/**
 * Read `error.code` (+ optional sibling fields) off a non-2xx JSON body. The
 * route envelope is `{ error: { code, ...details } }`, so `current_status` and
 * `orphan_invoice_id` live directly on the `error` object. Falls back to
 * server_error on a malformed body.
 */
async function readError(res: Response): Promise<{
  code: string;
  current_status?: string;
  orphan_invoice_id?: string;
}> {
  try {
    const body = (await res.json()) as {
      error?: {
        code?: string;
        current_status?: string;
        orphan_invoice_id?: string;
      };
    };
    return {
      code: body.error?.code ?? 'server_error',
      ...(body.error?.current_status !== undefined
        ? { current_status: body.error.current_status }
        : {}),
      ...(body.error?.orphan_invoice_id !== undefined
        ? { orphan_invoice_id: body.error.orphan_invoice_id }
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
  const reasonInvalid =
    trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX;

  const trimmedReference = paymentReference.trim();
  const markPaidIncomplete =
    paymentMethod.length === 0 ||
    trimmedReference.length === 0 ||
    paymentDate.length === 0;

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
          const { code } = await readError(res);
          const key = `cancelCycle.error.${code}`;
          toast.error(
            t.has(key) ? t(key) : t('cancelCycle.error.server_error'),
          );
          return;
        }
        // Body is { status: 'cancelled', closed_at } — read to confirm shape.
        (await res.json()) as CancelSuccessBody;
        toast.success(t('cancelCycle.successToast'));
        setCancelOpen(false);
        setReason('');
        router.refresh();
      } catch {
        toast.error(t('cancelCycle.error.server_error'));
      }
    });
  };

  const onMarkPaid = () => {
    if (markPaidIncomplete) return;
    startMarkPaid(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${encodeURIComponent(cycleId)}/mark-paid-offline`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              payment_method: paymentMethod,
              payment_reference: trimmedReference,
              payment_date: paymentDate,
            }),
          },
        );
        if (!res.ok) {
          const { code, orphan_invoice_id } = await readError(res);
          if (code === 'f4_orphan_invoice' && orphan_invoice_id) {
            // DO-NOT-RETRY: an invoice was issued but the cycle flip failed.
            // The admin must resume from the F4 invoice list — surface the
            // deep-link in the toast so they can act without a support ticket.
            toast.error(t('markPaidOffline.error.f4_orphan_invoice'), {
              action: {
                label: t('markPaidOffline.viewOrphanInvoice'),
                onClick: () => {
                  router.push(
                    `/admin/invoices/${encodeURIComponent(orphan_invoice_id)}`,
                  );
                },
              },
              duration: 30_000,
            });
            return;
          }
          const key = `markPaidOffline.error.${code}`;
          toast.error(
            t.has(key) ? t(key) : t('markPaidOffline.error.server_error'),
          );
          return;
        }
        (await res.json()) as MarkPaidSuccessBody;
        toast.success(t('markPaidOffline.successToast'));
        setMarkPaidOpen(false);
        setPaymentReference('');
        setPaymentDate('');
        setPaymentMethod('bank_transfer');
        router.refresh();
      } catch {
        toast.error(t('markPaidOffline.error.server_error'));
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
          <Dialog
            open={markPaidOpen}
            onOpenChange={(open) => {
              setMarkPaidOpen(open);
              if (!open) {
                setPaymentReference('');
                setPaymentDate('');
                setPaymentMethod('bank_transfer');
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
