'use client';

/**
 * B7 / FR-026 — destructive banner surfaced on the invoice detail page when an
 * automatic F4 email (invoice/receipt copy) permanently failed to deliver.
 * Satisfies both halves of FR-026: "retry" = a Resend button reusing the
 * existing POST /api/invoices/[id]/resend flow; "edit the recipient" = a hint
 * pointing the admin at the member's primary-contact email (F4 has no per-
 * invoice recipient override). `<Alert>` carries role="alert".
 */
import { useState, useTransition } from 'react';
import { Loader2Icon, MailWarningIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function EmailFailureAlert({
  invoiceId,
  recipientEmail,
  variant,
  canResend,
}: {
  readonly invoiceId: string;
  readonly recipientEmail: string;
  /** The document that failed — resend the SAME one (receipt vs invoice copy). */
  readonly variant: 'invoice' | 'receipt';
  readonly canResend: boolean;
}): React.ReactElement {
  const t = useTranslations('admin.invoices.detail');
  const [pending, startTransition] = useTransition();
  // 5-min re-enable guard so a queued resend can't be hammered (mirrors
  // invoice-more-menu's recentlySent pattern).
  const [recentlySent, setRecentlySent] = useState(false);

  const handleResend = () => {
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/invoices/${invoiceId}/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant }),
        });
      } catch (err) {
        console.error('[email-failure-alert] resend network error', {
          invoiceId,
          err,
        });
        toast.error(t('toast.resendFailed'));
        return;
      }
      if (res.status === 202) {
        setRecentlySent(true);
        setTimeout(() => setRecentlySent(false), 5 * 60_000);
        toast.success(t('toast.resendSuccess', { recipient: recipientEmail }));
        return;
      }
      if (res.status === 429) {
        toast.warning(t('toast.resendRateLimited'));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      if (body.error?.code === 'not_issued') {
        toast.warning(t('toast.resendNotIssued'));
      } else {
        toast.error(t('toast.resendFailed'));
      }
    });
  };

  return (
    <Alert variant="destructive">
      <MailWarningIcon className="size-4" aria-hidden="true" />
      <AlertTitle>{t('deliveryFailure.title')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('deliveryFailure.body', { recipient: recipientEmail })}</span>
        {/* The "…then resend" hint only makes sense when a resend is offered
            (e.g. on a void invoice canResend is false → no button). */}
        {canResend ? (
          <span>{t('deliveryFailure.editRecipientHint')}</span>
        ) : null}
        {canResend ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={pending || recentlySent}
            aria-busy={pending}
            onClick={handleResend}
          >
            {pending ? (
              <Loader2Icon
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : null}
            {t('deliveryFailure.resend')}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
