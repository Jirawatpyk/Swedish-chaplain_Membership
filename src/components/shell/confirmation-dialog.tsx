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
import { useRef, type ReactNode } from 'react';
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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmDisabled}
            aria-disabled={confirmDisabled || undefined}
            onClick={(event) => {
              event.preventDefault();
              if (confirmDisabled) return;
              // F6 Phase 8 silent-failure C-1 fix (2026-05-16): always close
              // (when `closeOnConfirm`) AND surface rejections to the console
              // + global error boundary via `queueMicrotask(throw)`. The
              // previous `void Promise.resolve(...).then(...)` chain dropped
              // rejections silently — a shared-primitive bug that every
              // ConfirmationDialog consumer inherited.
              void Promise.resolve()
                .then(() => onConfirm())
                .catch((err: unknown) => {
                  console.error('[ConfirmationDialog] onConfirm rejected', err);
                  queueMicrotask(() => {
                    throw err;
                  });
                })
                .finally(() => {
                  if (closeOnConfirm) onOpenChange(false);
                });
            }}
            className={destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
