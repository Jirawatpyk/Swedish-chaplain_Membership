/**
 * F5 Phase 5 (T099) — Client-side copy-to-clipboard for the processor
 * charge id surfaced on the payment-timeline card.
 *
 * Uses `navigator.clipboard.writeText` (HTTPS-only API; the admin
 * portal is HTTPS-only in prod and dev runs through the local
 * `localhost` exception which the spec allows). Falls back silently
 * when the API is unavailable — the chip text stays selectable for
 * manual copy.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function CopyChargeIdButton({ chargeId }: { chargeId: string }) {
  const t = useTranslations('admin.paymentReconciliation.timeline.chargeId');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(chargeId);
      setCopied(true);
      toast.success(t('copySuccess'));
      // Reset the icon after 2 s so the user gets visual confirmation
      // without a permanent state change. Sonner handles the toast
      // dismissal independently.
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Silent — the chip text remains selectable as a fallback.
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      data-testid="copy-charge-id-button"
      aria-label={t('copyAction')}
      className="h-7 px-2"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-emerald-600" aria-hidden="true" />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden="true" />
      )}
      <span className="sr-only">{t('copyAction')}</span>
    </Button>
  );
}
