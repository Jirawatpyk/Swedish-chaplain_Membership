/**
 * T107 — Portal "Email me a copy" ghost button.
 *
 * Client component — POSTs to `/api/portal/invoices/[id]/resend` and
 * surfaces a toast with the outcome. Rate-limit feedback (429) gets a
 * softer "try later" copy; unknown failures fall back to a generic
 * retry prompt.
 *
 * Used on both the list row (compact label) and the detail page (full
 * label). The accessible label always names the invoice document
 * number so screen-reader users hear unambiguous action text.
 */
'use client';

import { useTransition, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ResendInvoiceButtonProps {
  readonly invoiceId: string;
  readonly documentNumber: string;
  /** 'ghost' for detail page, 'outline' for list row — defaults to 'ghost'. */
  readonly variant?: 'ghost' | 'outline';
  /** Compact label vs. full label — 'compact' shows the icon only; 'full' shows text. */
  readonly layout?: 'compact' | 'full';
  /** Extra classes (min-h, width). */
  readonly className?: string;
}

export function ResendInvoiceButton({
  invoiceId,
  documentNumber,
  variant = 'ghost',
  layout = 'full',
  className,
}: ResendInvoiceButtonProps) {
  const t = useTranslations('portal.invoices');
  const [isPending, startTransition] = useTransition();
  // Lock out the button after success for the same 5-minute window the
  // API enforces so the user isn't tempted to spam the toast; purely
  // UX — the API rate-limit is the source of truth.
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
      try {
        const res = await fetch(`/api/portal/invoices/${invoiceId}/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.status === 202) {
          setRecentlySent(true);
          if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
          unlockTimerRef.current = setTimeout(
            () => setRecentlySent(false),
            5 * 60_000,
          );
          toast.success(t('toast.resendSuccess'));
          return;
        }
        if (res.status === 429) {
          toast.warning(t('toast.resendRateLimited'));
          return;
        }
        toast.error(t('toast.resendFailed'));
      } catch (err) {
        // Round 6 (R5-SF-L1 parity) — log network error to console
        // so the user-facing toast still shows but operators retain
        // the underlying cause (DNS / CORS / offline / TLS) for
        // diagnosis. Bare catch swallowed this previously.
        // eslint-disable-next-line no-console
        console.error('[portal-resend-invoice] network error', {
          invoiceId,
          err,
        });
        toast.error(t('toast.resendFailed'));
      }
    });
  };

  const disabled = isPending || recentlySent;

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={handleClick}
      disabled={disabled}
      aria-label={t('actions.emailCopyAria', { number: documentNumber })}
      className={className}
    >
      {isPending ? (
        // Round 6 (R5-UX-M2 parity) — `motion-safe:` prefix so users
        // with `prefers-reduced-motion: reduce` don't see a continuously
        // spinning icon.
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Mail className="size-4" aria-hidden="true" />
      )}
      {layout === 'full' ? (
        <span className="ml-2">{t('actions.emailCopy')}</span>
      ) : null}
    </Button>
  );
}
