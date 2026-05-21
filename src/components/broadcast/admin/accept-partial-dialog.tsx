'use client';

/**
 * T054 (F7.1a US1) — Accept-partial-delivery confirmation dialog.
 *
 * Terminal state transition `partially_sent → partial_delivery_accepted`
 * with optional admin-supplied reason ≤500 chars (FR-008c). Wraps
 * `POST /api/admin/broadcasts/[id]/accept-partial`.
 *
 * Key differences vs `retry-confirmation-dialog.tsx` (T053):
 *   - Terminal action (no budget) — destructive-styled confirm button
 *   - Optional reason textarea with live counter (matches reject-
 *     dialog.tsx pattern but `optional` not `required`)
 *   - Different toast errors (no budget-exhausted code path)
 *
 * UX (per docs/ux-standards.md):
 *   - Auto-focus on reason textarea when opened (double-RAF mount
 *     guarantee — copies the reject-dialog approach)
 *   - ESC closes, Submit disabled while pending
 *   - aria-live counter for character count
 *
 * i18n keys: admin.broadcasts.acceptPartialDialog.* + admin.broadcasts.toast.*
 */
import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
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

export interface AcceptPartialDialogProps {
  readonly broadcastId: string;
  readonly sentBatchCount: number;
  readonly totalBatchCount: number;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /**
   * Phase 3F.9 (UX F-6) — see RetryConfirmationDialog header doc for
   * the focus-return rationale. WCAG SC 2.4.3 / SC 2.4.11.
   */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /** Phase 3F.11.14 (UX M1) — see RetryConfirmationDialog. */
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function AcceptPartialDialog({
  broadcastId,
  sentBatchCount,
  totalBatchCount,
  open,
  onOpenChange,
  triggerRef,
  fallbackFocusRef,
}: AcceptPartialDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.acceptPartialDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState<string>('');
  const [pending, startTransition] = useTransition();

  // UX M-4 fix 2026-05-21 (review finding enterprise-ux-designer M-4):
  // initial focus goes to AlertDialogCancel via `autoFocus` (set below
  // at the Cancel button), matching `retry-confirmation-dialog.tsx:175`
  // pattern + docs/ux-standards.md § 6.2 destructive-action convention
  // (keyboard users land on the safe action first). The textarea-focus
  // useEffect was removed: it inverted the safety intent on a terminal,
  // irreversible action (Shift+Tab from textarea reached Confirm
  // directly). Members who WANT to write a reason still Tab once from
  // Cancel to reach the textarea — adds one keystroke for the typed-
  // reason path, eliminates the "accidentally Shift+Tab into the
  // destructive Confirm" footgun for everyone else. The textareaRef
  // is preserved for `onOpenChange` cleanup symmetry.

  function handleOpenChange(next: boolean): void {
    if (!next) setReason('');
    onOpenChange(next);
  }

  const overCap = reason.length > MAX_REASON_LENGTH;
  const submitDisabled = pending || overCap;

  function onConfirm(): void {
    if (submitDisabled) return;
    startTransition(async () => {
      try {
        const trimmed = reason.trim();
        const body: { reason?: string } = {};
        if (trimmed.length > 0) body.reason = trimmed;

        const res = await fetch(
          `/api/admin/broadcasts/${broadcastId}/accept-partial`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        if (res.ok) {
          toast.success(tToast('acceptPartialSuccess'));
          onOpenChange(false);
          router.refresh();
          return;
        }

        const errBody = (await res.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const code = errBody?.error?.code;
        switch (code) {
          case 'broadcast_invalid_state_transition':
            toast.error(tToast('acceptPartialInvalidState'));
            break;
          case 'broadcast_partial_delivery_reason_too_long':
            toast.error(tToast('acceptPartialReasonTooLong'));
            break;
          default:
            toast.error(tToast('acceptPartialServerError'));
        }
        onOpenChange(false);
        router.refresh();
      } catch {
        toast.error(tToast('acceptPartialServerError'));
      }
    });
  }

  // Phase 3F.11.14 (UX M1) — function variant of finalFocus so we can
  // fall back to fallbackFocusRef when the trigger button is unmounted.
  // See RetryConfirmationDialog for the lint-fix rationale (3F.11.17).
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      triggerRef?.current ?? fallbackFocusRef?.current ?? null,
    [triggerRef, fallbackFocusRef],
  );

  return (
    // Phase 3F.11.1 (C1 — Round 2 fix) — see RetryConfirmationDialog
    // header doc.
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-lg" finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm font-medium text-foreground">
          {t('summary', { sent: sentBatchCount, total: totalBatchCount })}
        </p>
        <div className="space-y-2">
          <Label htmlFor="accept-partial-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="accept-partial-reason"
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={4}
            disabled={pending}
            aria-describedby="accept-partial-reason-help accept-partial-reason-counter"
            aria-invalid={overCap}
          />
          <p
            id="accept-partial-reason-help"
            className="text-xs text-muted-foreground"
          >
            {t('reasonHelp')}
          </p>
          <p
            id="accept-partial-reason-counter"
            aria-live="polite"
            className={cn(
              'text-xs',
              overCap
                ? 'font-semibold text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {t('reasonCounter', { count: reason.length })}
          </p>
        </div>
        <AlertDialogFooter>
          {/*
            LOW4 Round 5 doc note 2026-05-21 (review finding
            enterprise-ux-designer M-4): `autoFocus` on a `disabled`
            element is HTML undefined behaviour, but works correctly
            HERE because `pending` is `false` at the moment the dialog
            mounts (the transition only starts after the admin clicks
            Confirm). Browser focuses Cancel on mount, ignores the
            (then-stale) `autoFocus` after disabled flips true mid-
            transition. Pattern matches `retry-confirmation-dialog.tsx:
            176` precedent; works in NVDA + VoiceOver + Chrome/Firefox/
            Safari per Round 5 manual sweep. If a future refactor
            initialises `pending=true` (e.g., dialog auto-submits on
            mount), this autoFocus would silently fail and Cancel
            wouldn't receive focus — convert to controlled focus via
            `useRef + useEffect` at that point.
          */}
          <AlertDialogCancel disabled={pending} autoFocus>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={submitDisabled}
            className={cn(
              // Destructive-styled — accepting partial is terminal +
              // irreversible, matches reject-dialog convention.
              'bg-destructive text-destructive-foreground',
              'hover:bg-destructive/90',
              'focus-visible:ring-destructive',
            )}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending ? (
              <>
                <Loader2
                  className="mr-2 size-4 motion-safe:animate-spin"
                  aria-hidden="true"
                />
                {t('submitting')}
              </>
            ) : (
              t('confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default AcceptPartialDialog;
