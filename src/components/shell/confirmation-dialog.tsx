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
   * Phase 5 review-fix W-04 (2026-05-13) — disable the confirm action
   * while a parent-side gate is unfulfilled (e.g. the embedded
   * WebhookSecretReveal's saved-checkbox in the post-rotation flow).
   * Cancel always stays enabled so the user can back out.
   */
  readonly confirmDisabled?: boolean;
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
              void Promise.resolve(onConfirm()).then(() => onOpenChange(false));
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
