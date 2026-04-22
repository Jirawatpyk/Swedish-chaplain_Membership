'use client';

/**
 * Credit-note detail "⋯" menu — twin of `InvoiceMoreMenu`. Collapses
 * Download PDF + Resend CN email into one ghost icon-only dropdown so
 * the action row only exposes primary navigation ("Back to invoice")
 * as a standalone button. Pattern is documented in
 * `docs/ux-standards.md` § 19 (Icon-trigger zones).
 *
 * Resend logic is inlined (copy of the former resend-cn-button
 * handler) so T107's 5-minute client-side re-enable + keyed toasts
 * behave 1:1.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, Loader2, Mail, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface CreditNoteMoreMenuProps {
  readonly creditNoteId: string;
  readonly documentNumber: string;
}

export function CreditNoteMoreMenu({
  creditNoteId,
  documentNumber,
}: CreditNoteMoreMenuProps) {
  const t = useTranslations('admin.creditNotes.detail');

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
      } else {
        toast.error(t('toast.resendFailed'));
      }
      setIsPending(false);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon-lg"
            // `flex-none!` (note the `!` important suffix) prevents
            // PageHeader's mobile `[&>*]:flex-1` rule from stretching
            // the overflow trigger. The parent selector carries higher
            // specificity (0,1,1) than a bare `.flex-none` class (0,1,0),
            // so `!` is required to force the compact 36×36 square
            // mandated by ux-standards.md § 19.
            className="flex-none!"
            aria-label={t('actions.moreAria', { number: documentNumber })}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
        <DropdownMenuItem
          render={(props) => (
            <a
              {...props}
              href={`/api/credit-notes/${creditNoteId}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              download
            >
              <Download aria-hidden="true" />
              {t('actions.download')}
            </a>
          )}
        />
        <DropdownMenuItem
          disabled={isPending || recentlySent}
          onClick={handleResend}
          aria-label={t('actions.resendAria', { number: documentNumber })}
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Mail aria-hidden="true" />
          )}
          {t('actions.resend')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
