/**
 * T107 — Admin "Resend credit note email" button.
 *
 * POSTs to `/api/credit-notes/[id]/resend`. Toasts outcome.
 */
'use client';

import { useTransition, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ResendCnButtonProps {
  readonly creditNoteId: string;
  readonly documentNumber: string;
}

export function ResendCnButton({
  creditNoteId,
  documentNumber,
}: ResendCnButtonProps) {
  const t = useTranslations('admin.creditNotes.detail');
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
        res = await fetch(`/api/credit-notes/${creditNoteId}/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
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
          t('toast.resendSuccess', { recipient: body.recipientEmail ?? '' }),
        );
        return;
      }
      if (res.status === 429) {
        toast.warning(t('toast.resendRateLimited'));
        return;
      }
      toast.error(t('toast.resendFailed'));
    });
  };

  const disabled = isPending || recentlySent;

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={disabled}
      aria-label={t('actions.resendAria', { number: documentNumber })}
    >
      {isPending ? (
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Mail className="mr-2 size-4" aria-hidden="true" />
      )}
      {t('actions.resend')}
    </Button>
  );
}
