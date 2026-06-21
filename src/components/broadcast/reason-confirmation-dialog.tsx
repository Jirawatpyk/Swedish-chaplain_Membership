'use client';

/**
 * Shared reason-confirmation dialog (DV-12 review follow-up #11).
 *
 * Extracted from the near-identical reject-dialog.tsx + cancel-broadcast-dialog.tsx
 * pair (they shared ~180 lines: the double-RAF focus effect, the finalFocus
 * chain, the Label+Textarea+counter+over-cap block, the destructive footer, the
 * validation + pending plumbing). This component owns all of that shared UI +
 * state; each caller (reject / cancel) stays a thin wrapper that owns ONLY its
 * own fetch + toast + close + refresh via the `onConfirm` callback.
 *
 * Design seam (see DV-12 understand-phase reject behavior contract):
 *   - `onConfirm(reason)` is called inside this component's `useTransition`, so
 *     the caller does NOT manage `pending`; this component disables the
 *     textarea + buttons while the caller's promise is in flight.
 *   - The RAW (untrimmed) reason is passed to `onConfirm` so callers preserve
 *     their verbatim-reason wire contract (reject sends the reason verbatim).
 *   - Response parsing / status→toast mapping stays in each caller (reject reads
 *     no body and maps any 409 → concurrentRace; cancel reads body.error.code
 *     and splits too-late vs concurrent vs generic). Do NOT lift fetch here.
 *   - Focus rule: `reasonRequired ? auto-focus the textarea (double-RAF) :
 *     initial-focus the Cancel button (Base UI initialFocus)`. This reproduces
 *     reject (always required → textarea) and cancel (admin → textarea, member →
 *     Cancel button) exactly.
 *   - Reason is reset on OPEN (not on close) so a re-open is always fresh
 *     regardless of how the previous interaction closed — this is the robust
 *     fix for the "stale reason on programmatic close" review finding (#1):
 *     success/409 close paths call the caller's `onOpenChange(false)` directly
 *     (Base UI does not fire onOpenChange for a controlled programmatic close),
 *     so resetting on close would miss them; resetting on open covers every path.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useTranslations } from 'next-intl';
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
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';

/**
 * F7-A11Y-1 — shared focus-return chain for the broadcast confirmation dialogs.
 *
 * Returns a `finalFocus` callback Base UI calls on close. The trigger button
 * lives outside the dialog and UNMOUNTS after the programmatic close paths
 * (success / 409 / — for cancel — 404/403), each of which runs
 * `router.refresh()` and flips the row out of its actionable status. At the
 * instant Base UI reads finalFocus the trigger is STILL mounted, so returning
 * it would drop focus to <body> milliseconds later.
 *
 * Pass `closedViaSuccessRef` (raised by the caller on those programmatic
 * closes): when set, the resolver SKIPS the about-to-unmount trigger and lands
 * on the surviving fallbackFocusRef → #main-content landmark (focusable via
 * tabIndex=-1). On Cancel / ESC the flag stays false, so the trigger is
 * returned. WCAG 2.1 AA SC 2.4.3. See {@link resolveDialogFinalFocus}.
 *
 * Each caller invokes this hook and passes the result as `finalFocus={…}` so the
 * wiring stays visible at the call site (keeps approve-reject-final-focus.test
 * source assertions valid).
 */
export function useDialogFinalFocus(
  triggerRef?: React.RefObject<HTMLButtonElement | null>,
  fallbackFocusRef?: React.RefObject<HTMLElement | null>,
  closedViaSuccessRef?: React.RefObject<boolean>,
): () => HTMLElement | null {
  return useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef?.current ?? false,
        trigger: triggerRef?.current ?? null,
        fallback: fallbackFocusRef?.current ?? null,
        mainContent:
          typeof document !== 'undefined'
            ? document.getElementById('main-content')
            : null,
      }),
    [triggerRef, fallbackFocusRef, closedViaSuccessRef],
  );
}

export interface ReasonConfirmationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /** next-intl namespace for the dialog strings (title, description, reason fields, confirm, cancel, errors.reasonTooLong). */
  readonly namespace: string;
  /** Max reason length (reject = 2000, cancel = 500). */
  readonly maxLength: number;
  /**
   * true  → reason required (1..maxLength); textarea auto-focuses on open.
   * false → reason optional (≤maxLength); the Cancel button receives initial focus.
   */
  readonly reasonRequired: boolean;
  /** Unique id prefix for the textarea + its aria-describedby targets (e.g. 'reject-reason'). */
  readonly fieldIdPrefix: string;
  /** Textarea rows (reject = 5, cancel = 4). */
  readonly textareaRows: number;
  /**
   * Caller-owned submission. Receives the RAW (untrimmed) reason. Runs inside
   * this component's useTransition; the caller does fetch + toast + close +
   * refresh and may throw (kept open for retry). Errors are swallowed here so
   * `pending` always resets — the caller is responsible for surfacing them.
   */
  readonly onConfirm: (reason: string) => Promise<void>;
  /** Focus-return target on close — build via {@link useDialogFinalFocus}. */
  readonly finalFocus: () => HTMLElement | null;
}

export function ReasonConfirmationDialog({
  open,
  onOpenChange,
  namespace,
  maxLength,
  reasonRequired,
  fieldIdPrefix,
  textareaRows,
  onConfirm,
  finalFocus,
}: ReasonConfirmationDialogProps): React.ReactElement {
  const t = useTranslations(namespace);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  // Reset on OPEN so every re-open starts fresh — covers the programmatic close
  // paths (success / 409) that call onOpenChange(false) directly and bypass Base
  // UI's onOpenChange, which a reset-on-close would miss (stale-reason fix #1).
  // Uses the render-time "adjust state when a prop changes" pattern (not an
  // effect) to avoid the react-hooks/set-state-in-effect cascade rule.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setReason('');
  }

  // Required-reason dialogs auto-focus the textarea via chained double-RAF
  // (mirrors the original reject/cancel Review UX I4 pattern — no fixed timeout
  // that races on slow devices / reduced-motion). Optional-reason dialogs
  // instead hand initial focus to the Cancel button via Base UI `initialFocus`.
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

  const overCap = reason.length > maxLength;
  const valid = reasonRequired
    ? reason.trim().length >= 1 && !overCap
    : !overCap;

  function handleConfirm(): void {
    if (!valid || pending) return;
    startTransition(async () => {
      // Caller owns fetch/toast/close/refresh and may throw to keep the dialog
      // open for retry; swallow here so `pending` always settles.
      try {
        await onConfirm(reason);
      } catch {
        /* caller already surfaced the error toast */
      }
    });
  }

  const helpId = `${fieldIdPrefix}-help`;
  const counterId = `${fieldIdPrefix}-counter`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          <Label htmlFor={fieldIdPrefix}>{t('reasonLabel')}</Label>
          <Textarea
            id={fieldIdPrefix}
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={textareaRows}
            disabled={pending}
            aria-describedby={`${helpId} ${counterId}`}
            aria-invalid={overCap}
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            {t('reasonHelp')}
          </p>
          <p
            id={counterId}
            aria-live="polite"
            className={cn(
              'text-xs',
              overCap ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {reason.length} / {maxLength}
          </p>
          {overCap ? (
            <p className="text-xs text-destructive" role="alert">
              {t('errors.reasonTooLong')}
            </p>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>
            {t('cancel')}
          </AlertDialogCancel>
          {/* Destructive confirm — paint red per ux-standards § 6.2.
              preventDefault stops AlertDialogAction's default auto-close so the
              dialog only closes via the caller's onOpenChange after the fetch
              settles (stays open on a transient error for retry). */}
          <AlertDialogAction
            disabled={!valid || pending}
            className={cn(
              'bg-destructive text-destructive-foreground',
              'hover:bg-destructive/90',
              'focus-visible:ring-destructive',
            )}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
