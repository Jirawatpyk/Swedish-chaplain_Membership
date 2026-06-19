'use client';

/**
 * DV-12 — Shared Cancel-broadcast confirmation dialog (admin + member).
 *
 * Mirrors reject-dialog.tsx. Key differences:
 *   - Cap 500 chars (reject caps at 2000).
 *   - reasonRequired=true  → textarea focus on open; reason required (1–500).
 *   - reasonRequired=false → confirm button enabled with empty reason; only
 *     the ≤500 cap is enforced.
 *   - Reads body.error.code to split the two 409s:
 *       'broadcast_cancel_too_late'      → toast ${toastNamespace}.cancelTooLate
 *       anything else (e.g. concurrent)  → toast ${toastNamespace}.cancelError
 *   - finalFocus chains triggerRef → fallbackFocusRef → #main-content
 *     (WCAG 2.1 AA SC 2.4.3, mirrors approve/reject pattern).
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

const MAX_REASON_LENGTH = 500;

export interface CancelBroadcastDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** POST target: /api/admin/broadcasts/{id}/cancel or /api/broadcasts/{id}/cancel */
  readonly endpoint: string;
  /** next-intl namespace for the dialog strings, e.g. "admin.broadcasts.cancelDialog" */
  readonly namespace: string;
  /** next-intl namespace for toast strings, e.g. "admin.broadcasts.toast" */
  readonly toastNamespace: string;
  /**
   * Admin usage: true — reason is required (1–500 chars); textarea auto-focuses.
   * Member usage: false — reason is optional (≤500 chars); confirm button auto-focuses.
   */
  readonly reasonRequired: boolean;
  /**
   * F7-A11Y-1 — ref to the trigger button so focus returns to it
   * on close (Cancel / ESC paths where the trigger survives).
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * F7-A11Y-1 — optional fallback focus target when the trigger has been
   * unmounted (success path). Defaults to the layout's #main-content
   * landmark when omitted.
   */
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function CancelBroadcastDialog({
  broadcastId: _broadcastId,
  open,
  onOpenChange,
  endpoint,
  namespace,
  toastNamespace,
  reasonRequired,
  triggerRef,
  fallbackFocusRef,
}: CancelBroadcastDialogProps): React.ReactElement {
  const t = useTranslations(namespace);
  const tToast = useTranslations(toastNamespace);
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  // Admin (required reason) — auto-focus the textarea on open.
  // Double-RAF pattern mirrors reject-dialog.tsx (Review UX I4).
  useEffect(() => {
    if (!open || !reasonRequired) return undefined;
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
  }, [open, reasonRequired]);

  // Reset state on close — avoids React 19 strict-mode "setState in effect" cascade.
  function handleOpenChange(next: boolean): void {
    if (!next) setReason('');
    onOpenChange(next);
  }

  const overCap = reason.length > MAX_REASON_LENGTH;
  const valid = reasonRequired
    ? reason.trim().length >= 1 && !overCap
    : !overCap;

  function onConfirm(): void {
    if (!valid || pending) return;
    startTransition(async () => {
      try {
        const body = reason.trim()
          ? JSON.stringify({ cancellationReason: reason })
          : JSON.stringify({});
        const res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (res.ok) {
          toast.success(tToast('cancelled'));
          onOpenChange(false);
          router.refresh();
          return;
        }
        const json = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        if (res.status === 409) {
          if (json.error?.code === 'broadcast_cancel_too_late') {
            toast.error(tToast('cancelTooLate'));
          } else {
            toast.error(tToast('cancelError'));
          }
          onOpenChange(false);
          router.refresh();
        } else {
          toast.error(tToast('cancelError'));
        }
      } catch {
        toast.error(tToast('cancelError'));
      }
    });
  }

  // F7-A11Y-1 — focus return on close. Mirrors approve-dialog / reject-dialog.
  // triggerRef → fallbackFocusRef → #main-content landmark → null (Base UI <body>).
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
      <AlertDialogContent
        className="max-w-lg"
        finalFocus={finalFocus}
        {...(reasonRequired ? {} : { initialFocus: cancelRef })}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="cancel-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="cancel-reason"
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={4}
            disabled={pending}
            aria-describedby="cancel-reason-help cancel-reason-counter"
            aria-invalid={overCap}
          />
          <p id="cancel-reason-help" className="text-xs text-muted-foreground">
            {t('reasonHelp')}
          </p>
          <p
            id="cancel-reason-counter"
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
          <AlertDialogCancel ref={cancelRef} disabled={pending}>{t('cancel')}</AlertDialogCancel>
          {/* Destructive confirm — paint red per ux-standards § 6.2 */}
          <AlertDialogAction
            disabled={!valid || pending}
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
export { CancelBroadcastDialog as default };
