'use client';

/**
 * Credit-note detail header actions (spec 122 US8c, T845; board
 * `Admin-credit-note-detail`): Resend email and Download PDF as buttons, in
 * place of the former ⋯ menu.
 *
 * The resend handler is the menu's, unchanged: the same POST, the keyed
 * toasts per status (202, 429, 409 `no_recipient` / `no_buyer_email`) and
 * T107's 5-minute client-side re-enable.
 */
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, buttonClass } from '@jirawatpyk/aura-react';
import { DownloadIcon } from 'lucide-react';
import { toast } from '@/lib/toast';

export interface CreditNoteActionsProps {
  readonly creditNoteId: string;
  readonly documentNumber: string;
}

export function CreditNoteActions({ creditNoteId, documentNumber }: CreditNoteActionsProps) {
  const t = useTranslations('admin.creditNotes.detail');
  const resendHintId = useId();

  const [isPending, setIsPending] = useState(false);
  const [recentlySent, setRecentlySent] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, startTransition] = useTransition();

  useEffect(
    () => () => {
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    },
    [],
  );

  const handleResend = () => {
    setIsPending(true);
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
        setIsPending(false);
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
        setIsPending(false);
        return;
      }
      if (res.status === 429) {
        toast.warning(t('toast.resendRateLimited'));
      } else if (res.status === 409) {
        // 108 FR-003 — the one resend failure a staff member can actually fix.
        // "Resend failed" would send them to the logs for a data problem that
        // is two clicks away on the member page.
        const failure = (await res.json().catch(() => null)) as
          | { error?: { code?: string } }
          | null;
        const code = failure?.error?.code;
        toast.error(
          code === 'no_recipient'
            ? t('toast.resendNoRecipient')
            : // Round-5 finding #1/#9 — a NON-MEMBER event credit note. Its copy
              // existed in all three locales from round 4 but had no consumer,
              // because only the invoice path returned this code; the credit-note
              // path answered `no_recipient` and told staff to fix a member page
              // that does not exist for this document. Translated dead copy also
              // disguised the missing branch from anyone reading the message file.
              code === 'no_buyer_email'
              ? t('toast.resendNoBuyerEmail')
              : t('toast.resendFailed'),
        );
      } else {
        toast.error(t('toast.resendFailed'));
      }
      setIsPending(false);
    });
  };

  return (
    <>
      <Button
        variant="secondary"
        icon="mail"
        touchHeight
        loading={isPending}
        disabled={isPending || recentlySent}
        onClick={handleResend}
        aria-describedby={resendHintId}
      >
        {t('actions.resendShort')}
      </Button>
      {/* WCAG 2.5.3: the button keeps its visible words as its name; who the
          copy goes to is its description. */}
      <span id={resendHintId} className="sr-only">
        {t('actions.resendAria', { number: documentNumber })}
      </span>
      <a
        href={`/api/credit-notes/${creditNoteId}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        download
        className={buttonClass({ variant: 'primary', touchHeight: true })}
      >
        <DownloadIcon aria-hidden="true" className="size-4" />
        {t('actions.download')}
      </a>
    </>
  );
}
