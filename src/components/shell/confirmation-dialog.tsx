'use client';

/**
 * ConfirmationDialog wrapper around shadcn/Base-UI `alert-dialog`
 * (T134, ux-standards § 6).
 *
 * Keyboard:
 *   - Escape closes (Cancel)
 *   - Tab cycles within the dialog
 *   - Focus lands on CANCEL by default (ux-standards § 6 "safest
 *     default"), not Confirm — prevents accidental destruction via
 *     muscle memory
 *
 * The title, description, and button labels are passed as props so
 * callers can localise them via `useTranslations` at the call site.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Loader2Icon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
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

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly destructive?: boolean;
  readonly children?: ReactNode;
  /**
   * Disable the confirm action while a parent-side gate is unfulfilled
   * (e.g. a wrapping component needs the user to tick a checkbox before
   * the destructive action becomes available). Cancel always stays
   * enabled so the user can back out. Introduced in Phase 5 review-fix
   * W-04 (2026-05-13).
   */
  readonly confirmDisabled?: boolean;
  /**
   * F6 Phase 8 T100 (2026-05-16) — when true (default), the dialog
   * auto-closes after `onConfirm` resolves. Pass `false` for flows
   * where `onConfirm` is a state TRANSITION (not termination) and the
   * dialog should re-render into a follow-up view via parent-state
   * change. Example: rotate-secret pre-confirmation → post-rotation
   * one-time-reveal — the auto-close races the parent's
   * `setRotationResult(...)` and erases the new secret from state
   * before the admin can copy it. The parent owns the close in those
   * flows.
   */
  readonly closeOnConfirm?: boolean;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive,
  children,
  confirmDisabled = false,
  closeOnConfirm = true,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // UX-2 fix (double-fire guard): without this, a fast double-click on
  // Confirm re-enters `onConfirm` before the first call settles — for an
  // irreversible action (e.g. revoke) that fires the mutation twice and
  // surfaces contradictory success + error toasts. `submitting` disables
  // BOTH buttons for the duration of the in-flight `onConfirm` call.
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirmClick(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    event.preventDefault();
    if (confirmDisabled || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err: unknown) {
      // F6 Phase 8 silent-failure C-1 fix (2026-05-16), preserved: surface
      // rejections to the console + global error boundary via
      // `queueMicrotask(throw)` rather than dropping them silently — a
      // shared-primitive bug every ConfirmationDialog consumer inherited.
      console.error('[ConfirmationDialog] onConfirm rejected', err);
      queueMicrotask(() => {
        throw err;
      });
    } finally {
      setSubmitting(false);
      if (closeOnConfirm) onOpenChange(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Explicit initialFocus on Cancel (ux-standards § 6 "safest default") —
          don't rely on DOM order, which a CSS reorder could silently break. */}
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={submitting}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmDisabled || submitting}
            aria-disabled={confirmDisabled || submitting || undefined}
            onClick={(event) => {
              void handleConfirmClick(event);
            }}
            className={destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
          >
            {submitting ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
