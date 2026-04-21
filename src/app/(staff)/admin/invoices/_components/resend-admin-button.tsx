/**
 * T107 — Admin "Resend invoice email" / "Resend receipt email" button.
 *
 * POSTs to `/api/invoices/[id]/resend` with `{ variant }`. Toasts the
 * outcome (success / rate-limit / no-receipt / not-issued / generic).
 *
 * Keyed error-to-copy mapping per i18n:
 *   429                  → toast.resendRateLimited
 *   409 no_receipt_pdf   → toast.resendNoReceipt
 *   409 not_issued       → toast.resendNotIssued
 *   any other non-202    → toast.resendFailed
 */
'use client';

import { useTransition, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ResendAdminButtonProps {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly variant: 'invoice' | 'receipt';
}

export function ResendAdminButton({
  invoiceId,
  documentNumber,
  variant,
}: ResendAdminButtonProps) {
  const t = useTranslations('admin.invoices.detail');
  const [isPending, startTransition] = useTransition();
  const [recentlySent, setRecentlySent] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    },
    [],
  );

  const handleClick = () => {
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/invoices/${invoiceId}/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant }),
        });
      } catch {
        toast.error(t('toast.resendFailed'));
        return;
      }

      if (res.status === 202) {
        const body = (await res.json().catch(() => ({}))) as {
          recipientEmail?: string;
        };
        setRecentlySent(true);
        if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = setTimeout(
          () => setRecentlySent(false),
          5 * 60_000,
        );
        toast.success(
          t('toast.resendSuccess', {
            recipient: body.recipientEmail ?? '',
          }),
        );
        return;
      }
      if (res.status === 429) {
        toast.warning(t('toast.resendRateLimited'));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = body.error?.code;
      if (code === 'no_receipt_pdf') {
        toast.warning(t('toast.resendNoReceipt'));
        return;
      }
      if (code === 'not_issued') {
        toast.warning(t('toast.resendNotIssued'));
        return;
      }
      toast.error(t('toast.resendFailed'));
    });
  };

  const disabled = isPending || recentlySent;

  const label =
    variant === 'invoice'
      ? t('actions.resendInvoice')
      : t('actions.resendReceipt');
  const documentType = variant === 'invoice' ? 'invoice' : 'receipt';

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={disabled}
      aria-label={t('actions.resendAria', {
        documentType,
        number: documentNumber,
      })}
    >
      {isPending ? (
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Mail className="mr-2 size-4" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
