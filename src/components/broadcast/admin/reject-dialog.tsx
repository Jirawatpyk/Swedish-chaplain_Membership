'use client';

/**
 * T119 — Reject confirmation dialog with required reason textarea.
 *
 * FR-012: rejectionReason is REQUIRED (≥1 non-whitespace, ≤2000 chars).
 * Member sees the verbatim reason in their notification email.
 *
 * UX:
 *   - Auto-focus on the reason textarea when open (CHK029)
 *   - ESC closes (handled by AlertDialog primitive)
 *   - Submit disabled while reason is empty / whitespace-only / too long
 *   - Live counter "n / 2000"
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_REASON_LENGTH = 2000;

export interface RejectDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /**
   * F7-A11Y-1 — ref to the Reject trigger button so focus returns to it
   * on close (Cancel / ESC paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * F7-A11Y-1 — optional fallback focus target when the trigger has been
   * unmounted (the success path unmounts ReviewActions). Defaults to the
   * layout's #main-content landmark when omitted.
   */
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function RejectDialog({
  broadcastId,
  open,
  onOpenChange,
  triggerRef,
  fallbackFocusRef,
}: RejectDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.rejectDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState<string>('');
  const [pending, startTransition] = useTransition();

  // Review UX I4 — use requestAnimationFrame chained with the dialog's
  // `data-open` mount cycle; double-RAF guarantees the AlertDialog has
  // finished mounting before we focus, with no fixed timeout that
  // races on slow devices / reduced-motion.
  useEffect(() => {
    if (!open) return undefined;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2 !== 0) window.cancelAnimationFrame(raf2);
    };
  }, [open]);

  // Reset state via the onOpenChange wrapper instead of an effect to
  // avoid React 19 strict-mode "setState in effect" cascade warning.
  function handleOpenChange(next: boolean): void {
    if (!next) setReason('');
    onOpenChange(next);
  }

  const trimmed = reason.trim();
  const lengthValid = trimmed.length >= 1 && reason.length <= MAX_REASON_LENGTH;
  const overCap = reason.length > MAX_REASON_LENGTH;

  function onConfirm() {
    if (!lengthValid || pending) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcastId}/reject`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rejectionReason: reason }),
        });
        if (res.ok) {
          toast.success(tToast('rejected'));
          onOpenChange(false);
          router.refresh();
        } else if (res.status === 409) {
          toast.error(tToast('concurrentRace'));
          onOpenChange(false);
          router.refresh();
        } else {
          toast.error(tToast('error'));
        }
      } catch {
        toast.error(tToast('error'));
      }
    });
  }

  // F7-A11Y-1 — focus return on close. The Reject trigger Button lives in
  // <ReviewActions>, which UNMOUNTS after a successful reject
  // (router.refresh flips the row out of 'submitted'), so Base UI's
  // default trigger-return would drop focus to <body>. finalFocus chains
  // triggerRef → fallbackFocusRef → the layout's #main-content landmark
  // (focusable via tabIndex=-1). WCAG 2.1 AA SC 2.4.3. See approve-dialog
  // for the full rationale.
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      triggerRef?.current ??
      fallbackFocusRef?.current ??
      (typeof document !== 'undefined'
        ? document.getElementById('main-content')
        : null),
    [triggerRef, fallbackFocusRef],
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-lg" finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="reject-reason"
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={5}
            disabled={pending}
            aria-describedby="reject-reason-help reject-reason-counter"
            aria-invalid={overCap}
          />
          <p id="reject-reason-help" className="text-xs text-muted-foreground">
            {t('reasonHelp')}
          </p>
          <p
            id="reject-reason-counter"
            aria-live="polite"
            className={cn(
              'text-xs',
              overCap ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {reason.length} / {MAX_REASON_LENGTH}
          </p>
          {overCap ? (
            <p className="text-xs text-destructive" role="alert">
              {t('errors.reasonTooLong')}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          {/* C2 UX hardening — Reject IS the destructive action; paint
              the confirm button red (ux-standards § 6.2). Default
              `AlertDialogAction` is primary blue which understates the
              destructive nature of sending a rejection email + freeing
              the member's quota slot. */}
          <AlertDialogAction
            disabled={!lengthValid || pending}
            className={cn(
              'bg-destructive text-destructive-foreground',
              'hover:bg-destructive/90',
              'focus-visible:ring-destructive',
            )}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Default-export helper to allow Button-as-trigger composition by parent
export { RejectDialog as default };
