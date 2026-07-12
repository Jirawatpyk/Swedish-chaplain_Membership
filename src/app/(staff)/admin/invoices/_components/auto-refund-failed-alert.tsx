'use client';

/**
 * F5 UX D2 — destructive banner surfaced on the admin invoice detail page when
 * an automatic stale-invoice refund permanently FAILED at the processor (the
 * `auto_refund_failed_needs_manual_reconcile` 10y forensic exists). The money
 * was NOT returned to the member — funds are stuck and a human must reconcile.
 *
 * Purely informational (no resend/action): mirrors the `EmailFailureAlert`
 * destructive visual vocabulary but points the admin at the out-of-band-refund
 * runbook + surfaces the FULL Stripe refund reference (staff look it up in the
 * Stripe Dashboard — no member-side last-8 truncation). `<Alert>` carries
 * role="alert". Stripe refund ids are stable identifiers — no PCI scope, no PII.
 */
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function AutoRefundFailedAlert({
  processorRefundId,
  runbookUrl,
}: {
  readonly processorRefundId: string | null;
  readonly runbookUrl: string;
}): React.ReactElement {
  const t = useTranslations('admin.invoices.detail');
  return (
    <Alert variant="destructive" data-testid="admin-invoice-auto-refund-failed-alert">
      <TriangleAlertIcon className="size-4" aria-hidden="true" />
      <AlertTitle>{t('autoRefundFailed.title')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('autoRefundFailed.body')}</span>
        {processorRefundId ? (
          <span
            className="font-mono text-xs"
            data-testid="admin-invoice-auto-refund-failed-ref"
          >
            {t('autoRefundFailed.ref', { ref: processorRefundId })}
          </span>
        ) : null}
        <span>{t('autoRefundFailed.runbook', { path: runbookUrl })}</span>
      </AlertDescription>
    </Alert>
  );
}
