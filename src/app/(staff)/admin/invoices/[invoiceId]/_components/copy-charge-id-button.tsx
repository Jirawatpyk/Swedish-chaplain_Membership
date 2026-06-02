/**
 * F5 Phase 5 (T099) — Client-side copy-to-clipboard for the processor
 * charge id surfaced on the payment-timeline card.
 *
 * Verify-fix bundle (2026-04-26):
 *   - R-I2: silent clipboard failure now surfaces a `toast.error` with
 *     a localised "copy failed — copy manually" hint.
 *   - U-I1: success path now adds a `role="status" aria-live="polite"`
 *     `sr-only` region so screen-reader users get explicit feedback
 *     beyond the visual icon swap (sonner toast SR support depends on
 *     `<Toaster>` config which is owned upstream).
 *   - M-1: touch target raised to 44 px (WCAG 2.5.5) via `min-h-11
 *     min-w-11` while keeping the visual density at h-7.
 *   - M-3: focus ring switched to `ring-2 ring-ring ring-offset-2`
 *     (shadcn / ux-standards § 7.5 pattern; the previous
 *     `outline-2 outline-ring` was not valid Tailwind v4 syntax).
 *   - M-4: removed the duplicate `sr-only` label that some screen
 *     readers paired with the existing `aria-label` to read the action
 *     name twice.
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
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      toast.error(t('copyFailed'));
      return;
    }
    try {
      await navigator.clipboard.writeText(chargeId);
      setCopied(true);
      toast.success(t('copySuccess'));
      // Reset the icon after 2 s so the user gets visual confirmation
      // without a permanent state change. Sonner handles the toast
      // dismissal independently.
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(t('copyFailed'));
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
      // Visual density h-7 (28 px) preserved — `min-h-11 min-w-11`
      // raises the actual touch hit-area to 44 px without growing the
      // rendered chrome row. WCAG 2.5.5 + ux-standards § mobile-first.
      className="h-7 min-h-11 min-w-11 px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {copied ? (
        <CheckIcon
          className="size-3.5 text-success"
          aria-hidden="true"
        />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden="true" />
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('copySuccessAnnouncement') : ''}
      </span>
    </Button>
  );
}
