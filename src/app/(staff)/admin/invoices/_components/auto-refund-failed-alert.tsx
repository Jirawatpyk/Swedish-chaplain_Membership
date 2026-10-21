'use client';

/**
 * F5 UX D2 + CF-2 — destructive banner surfaced on the admin invoice detail
 * page when an automatic stale-invoice refund permanently FAILED at the
 * processor (the `auto_refund_failed_needs_manual_reconcile` 10y forensic
 * exists). The money was NOT returned to the member — funds are stuck and a
 * human must reconcile.
 *
 * CF-2 adds a "Mark as reconciled" action: after the admin returns the funds
 * out-of-band (Stripe Dashboard refund / bank transfer — never a credit note,
 * the payment is a duplicate, not a sale; runbook § 1.5),
 * this confirms + POSTs to `/api/refunds/resolve-auto-refund-failure`, which
 * appends the append-only `auto_refund_reconciled` event so
 * `findStaleInvoiceAutoRefund.failed` flips false → THIS alert disappears on
 * refresh + the member banner reverts to "refunded". A confirmation dialog
 * gates the action (ux-standards — money/audit action). The banner keeps its
 * destructive tone; the button resolves it.
 *
 * AURA's danger `<Alert>` carries role="alert". Stripe refund ids are stable identifiers — no
 * PCI scope, no PII — so the FULL ref is shown (staff look it up in the Stripe
 * Dashboard; no member-side last-8 truncation).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, Button, Dialog } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';

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
    <Alert
      tone="danger"
      title={t('autoRefundFailed.title')}
      data-testid="admin-invoice-auto-refund-failed-alert"
      action={
        <Dialog
          role="alertdialog"
          open={open}
          onOpen={() => setOpen(true)}
          onClose={() => setOpen(false)}
          dismissible={!pending}
          trigger={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              touchHeight
              data-testid="admin-invoice-auto-refund-resolve-trigger"
            >
              {t('autoRefundFailed.resolve')}
            </Button>
          }
          title={t('autoRefundFailed.resolveConfirm.title')}
          description={t('autoRefundFailed.resolveConfirm.body')}
          footer={
            <>
              <Button variant="secondary" data-autofocus disabled={pending} onClick={() => setOpen(false)}>
                {t('autoRefundFailed.resolveConfirm.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={pending}
                onClick={confirmResolve}
                data-testid="admin-invoice-auto-refund-resolve-confirm"
              >
                {pending
                  ? t('autoRefundFailed.resolveConfirm.pending')
                  : t('autoRefundFailed.resolveConfirm.confirm')}
              </Button>
            </>
          }
        />
      }
    >
      <span className="flex flex-col gap-1">
        <span>{t('autoRefundFailed.body')}</span>
        {processorRefundId ? (
          <span className="break-all font-mono text-xs" data-testid="admin-invoice-auto-refund-failed-ref">
            {t('autoRefundFailed.ref', { ref: processorRefundId })}
          </span>
        ) : null}
        <span>{t('autoRefundFailed.runbook', { path: runbookUrl })}</span>
      </span>
    </Alert>
  );
}
