/**
 * DV-Wave2 ⑤ — `MarkPaidOfflineDialog`.
 *
 * The mark-paid-offline dialog, extracted VERBATIM (same route, same
 * `runAction` envelope, same `readError`, same orphan/existing-bill/
 * not-payable handling, same `isMarkPaidIncomplete` gate, same
 * `admin.renewals.cycleDetail.markPaidOffline.*` i18n namespace) from
 * `cycle-admin-actions.tsx` so it can be reused as a ROW action on the
 * pipeline table (Wave 2 Task 5) without a second settlement/mutation path
 * (Constitution Principle IV — reuse, never duplicate, a money-mutating
 * route). `cycle-admin-actions.tsx` now imports this component instead of
 * inlining its own copy of the dialog.
 *
 * Controlled component: the caller owns `open`/`onOpenChange` (and, for the
 * cycle-detail caller, the trigger Button that flips `open` — this file has
 * no trigger of its own, mirroring `OutreachDialog`).
 *
 * Focus-return (WCAG 2.1 SC 2.4.3): `finalFocus`, when passed, is a ref to
 * the CALLER's own trigger (e.g. the pipeline row's ⋯ button). A settlement
 * (or a 409 the route resolves by closing anyway — `membership_bill_
 * already_exists` / `cycle_not_payable`) always runs `router.refresh()`,
 * which can unmount the row (and its trigger) — so on those closes we skip
 * the about-to-vanish trigger and land on the `#main-content` landmark
 * instead of dropping focus to `<body>`, via the same
 * `resolveDialogFinalFocus` helper the F7/F8 dialogs already share. The
 * `f4_orphan_invoice` DO-NOT-RETRY branch does not close the dialog at all,
 * so the trigger is never at risk there. The cycle-detail caller passes NO
 * `finalFocus` (its trigger button does not unmount on this page — its own
 * `showMarkPaid` gate can flip, but Base UI's own default focus-restore
 * already covers that case, matching the pre-extraction behaviour exactly).
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { isMarkPaidIncomplete } from '../[cycleId]/_components/cycle-admin-validation';
import {
  resolveExistingBillHref,
  resolveOrphanInvoiceHref,
} from '../[cycleId]/_components/cycle-admin-error-codes';

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface MarkPaidOfflineDialogProps {
  readonly cycleId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fired after a real 2xx settlement (never on the stale-close 409s). */
  readonly onPaid?: () => void;
  /**
   * The caller's own trigger — see the file docstring's focus-return
   * section. Omit to keep Base UI's default restore-focus behaviour
   * (the cycle-detail caller's shape, unchanged from pre-extraction).
   */
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}

/**
 * Read `error.code` (+ optional invoice-id details) off a non-2xx JSON body.
 * COPIED VERBATIM from `cycle-admin-actions.tsx` (that file keeps its own
 * copy for the sibling cancel-cycle action, which is not part of this
 * extraction). The route envelope is `{ error: { code, ...details } }`.
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

export function MarkPaidOfflineDialog({
  cycleId,
  open,
  onOpenChange,
  onPaid,
  finalFocus,
}: MarkPaidOfflineDialogProps) {
  const t = useTranslations('admin.renewals.cycleDetail');
  const format = useFormatter();
  const router = useRouter();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Raised on every close that runs `router.refresh()` (real settlement OR
  // a stale-cycle 409 the route resolves by closing) — see
  // `resolveDialogFinalFocus`'s `closedViaSuccess` contract. A fresh
  // `useRef` per mount is correct here: the pipeline-table caller mounts a
  // brand-new instance per row-menu open (mirrors `OutreachDialog`'s lifted
  // pattern), so there is no stale value to reset between opens.
  const closedViaSuccessRef = useRef(false);

  const trimmedReference = paymentReference.trim();
  const incomplete = isMarkPaidIncomplete(paymentReference, paymentDate);

  const reset = (): void => {
    setPaymentReference('');
    setPaymentDate('');
    setPaymentMethod('bank_transfer');
  };

  /** Real 2xx settlement — closes, resets, refreshes, and tells the caller. */
  const succeed = (): void => {
    closedViaSuccessRef.current = true;
    onOpenChange(false);
    reset();
    router.refresh();
    onPaid?.();
  };

  /**
   * The cycle became stale under us (another admin acted first, or a live
   * bill already exists) — close + refresh so the now-invalid control
   * disappears, but do NOT fire `onPaid`: this submission settled nothing.
   */
  const closeStale = (): void => {
    closedViaSuccessRef.current = true;
    onOpenChange(false);
    reset();
    router.refresh();
  };

  const resolvedFinalFocus = finalFocus
    ? (): HTMLElement | null =>
        resolveDialogFinalFocus({
          closedViaSuccess: closedViaSuccessRef.current,
          trigger: finalFocus.current,
          fallback: null,
          mainContent:
            typeof document !== 'undefined'
              ? document.getElementById('main-content')
              : null,
        })
    : undefined;

  // Shared POST runner — COPIED VERBATIM from `cycle-admin-actions.tsx`'s
  // `runAction`, collapsed to the single `markPaidOffline` namespace (the
  // generic namespace parameter only existed there to share the runner with
  // the sibling cancel-cycle action, which stays behind in that file).
  const runAction = async (
    body: Record<string, unknown>,
    onSuccess: (data: unknown) => void,
    onError: (err: {
      code: string;
      orphan_invoice_id?: string;
      existing_invoice_id?: string;
    }) => boolean,
  ): Promise<void> => {
    try {
      const res = await fetch(
        `/api/admin/renewals/${encodeURIComponent(cycleId)}/mark-paid-offline`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = await readError(res);
        if (onError(err)) return;
        const key = `markPaidOffline.error.${err.code}`;
        toast.error(t.has(key) ? t(key) : t('markPaidOffline.error.server_error'));
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      onSuccess(data);
    } catch {
      toast.error(t('markPaidOffline.error.server_error'));
    }
  };

  // onMarkPaid — LIFTED VERBATIM from `cycle-admin-actions.tsx` (the
  // reanchored/no-email toast branches + the orphan/existing-bill/
  // not-payable error branches). Only the closing triple
  // (`setMarkPaidOpen(false)` / `resetMarkPaidFields()` / `router.refresh()`)
  // is replaced by `succeed()` (real settlement) or `closeStale()` (stale
  // 409s) — see those helpers' docs for why they are not collapsed into one.
  // No new network path: same route, same request body shape.
  const onMarkPaid = (): void => {
    if (incomplete) return;
    startTransition(() =>
      runAction(
        {
          payment_method: paymentMethod,
          payment_reference: trimmedReference,
          payment_date: paymentDate,
        },
        (data) => {
          // FIXED-ANCHOR (2026-07-22) — the member's one-and-only cycle was
          // ACTIVATED (not completed): status stays `upcoming` and
          // `anchored_at` is stamped, but the membership PERIOD keeps its
          // registration/backfill anchor — it does NOT move to the payment
          // month (that was the reverted #173 payment-anchor bug). Distinct
          // copy so the admin understands the cycle stayed `upcoming`
          // instead of completing. The toast's `{date}` is that fixed
          // period start. (The rare comeback exception — an already-expired
          // period at payment — re-anchors to a fresh period, and `{date}`
          // then renders the new start.)
          const dataObj = data as
            | {
                outcome?: string;
                new_period_from?: string;
                email_dispatch?: string;
              }
            | null;
          // Cluster 5 (Finding 1) parity — the §86/4 renewal receipt was
          // issued but the payment-time auto-email was SKIPPED (member has
          // no contact email on file). Append a non-blocking warning line
          // so the admin knows to deliver it manually.
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
          succeed();
        },
        (err) => {
          const orphanHref = resolveOrphanInvoiceHref(err);
          if (orphanHref) {
            // DO-NOT-RETRY: an invoice was issued but the cycle flip
            // failed. The admin must resume from the F4 invoice list —
            // surface the deep-link in the toast so they can act without a
            // support ticket. Dialog stays OPEN (nothing to refresh away).
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
            // NOTHING was minted. Point the operator at that invoice — the
            // F4 record-payment dialog there runs the same on-paid
            // callbacks, so it completes this cycle and opens the next
            // one. Then close + refresh so the stale action is not
            // re-clicked.
            toast.error(t('markPaidOffline.error.membership_bill_already_exists'), {
              action: {
                label: t('markPaidOffline.viewExistingInvoice'),
                onClick: () => {
                  router.push(existingBillHref);
                },
              },
              duration: 30_000,
            });
            closeStale();
            return true;
          }
          if (err.code === 'cycle_not_payable') {
            // The cycle is no longer payable (another admin acted): show
            // why, then close + refresh so the stale action disappears.
            toast.error(t('markPaidOffline.error.cycle_not_payable'));
            closeStale();
            return true;
          }
          return false;
        },
      ),
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent initialFocus={cancelRef} finalFocus={resolvedFinalFocus}>
        <DialogHeader>
          <DialogTitle>{t('markPaidOffline.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('markPaidOffline.dialogBody')}</DialogDescription>
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
                  translate={(v) => t(`markPaidOffline.paymentMethod.${v}`)}
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
              placeholder={t('markPaidOffline.paymentReferencePlaceholder')}
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
            ref={cancelRef}
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('markPaidOffline.cancel')}
          </Button>
          <Button onClick={onMarkPaid} disabled={pending || incomplete}>
            {pending ? (
              <>
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                {t('markPaidOffline.submitting')}
              </>
            ) : (
              t('markPaidOffline.confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
