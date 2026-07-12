'use client';

/**
 * F5 UX D2 + CF-2 — destructive banner surfaced on the admin invoice detail
 * page when an automatic stale-invoice refund permanently FAILED at the
 * processor (the `auto_refund_failed_needs_manual_reconcile` 10y forensic
 * exists). The money was NOT returned to the member — funds are stuck and a
 * human must reconcile.
 *
 * CF-2 adds a "Mark as reconciled" action: after the admin returns the funds
 * out-of-band (manual credit note / Stripe Dashboard refund, per the runbook),
 * this confirms + POSTs to `/api/refunds/resolve-auto-refund-failure`, which
 * appends the append-only `auto_refund_reconciled` event so
 * `findStaleInvoiceAutoRefund.failed` flips false → THIS alert disappears on
 * refresh + the member banner reverts to "refunded". A confirmation dialog
 * gates the action (ux-standards — money/audit action). The banner keeps its
 * destructive tone; the button resolves it.
 *
 * `<Alert>` carries role="alert". Stripe refund ids are stable identifiers — no
 * PCI scope, no PII — so the FULL ref is shown (staff look it up in the Stripe
 * Dashboard; no member-side last-8 truncation).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlertIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

export function AutoRefundFailedAlert({
  invoiceId,
  processorRefundId,
  runbookUrl,
}: {
  readonly invoiceId: string;
  readonly processorRefundId: string | null;
  readonly runbookUrl: string;
}): React.ReactElement {
  const t = useTranslations('admin.invoices.detail');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirmResolve() {
    startTransition(async () => {
      try {
        const res = await fetch('/api/refunds/resolve-auto-refund-failure', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invoiceId }),
        });
        if (!res.ok) {
          toast.error(t('autoRefundFailed.resolveError'));
          return;
        }
        toast.success(t('autoRefundFailed.resolveSuccess'));
        setOpen(false);
        // Re-fetch the RSC page: the reconcile event flips
        // `findStaleInvoiceAutoRefund.failed` false, so this alert disappears
        // + the member banner reverts on their next view.
        router.refresh();
      } catch {
        toast.error(t('autoRefundFailed.resolveError'));
      }
    });
  }

  return (
    <Alert variant="destructive" data-testid="admin-invoice-auto-refund-failed-alert">
      <TriangleAlertIcon className="size-4" aria-hidden="true" />
      <AlertTitle>{t('autoRefundFailed.title')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('autoRefundFailed.body')}</span>
        {processorRefundId ? (
          <span
            className="font-mono text-xs break-all"
            data-testid="admin-invoice-auto-refund-failed-ref"
          >
            {t('autoRefundFailed.ref', { ref: processorRefundId })}
          </span>
        ) : null}
        <span>{t('autoRefundFailed.runbook', { path: runbookUrl })}</span>
        <div className="mt-1">
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              data-testid="admin-invoice-auto-refund-resolve-trigger"
            >
              {t('autoRefundFailed.resolve')}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('autoRefundFailed.resolveConfirm.title')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('autoRefundFailed.resolveConfirm.body')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>
                  {t('autoRefundFailed.resolveConfirm.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    confirmResolve();
                  }}
                  disabled={pending}
                  aria-busy={pending}
                  data-testid="admin-invoice-auto-refund-resolve-confirm"
                >
                  {pending && (
                    <Loader2Icon
                      className="size-4 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {pending
                    ? t('autoRefundFailed.resolveConfirm.pending')
                    : t('autoRefundFailed.resolveConfirm.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </AlertDescription>
    </Alert>
  );
}
