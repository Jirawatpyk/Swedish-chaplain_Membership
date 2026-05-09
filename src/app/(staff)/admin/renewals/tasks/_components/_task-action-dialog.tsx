/**
 * F8 Phase 8 Round 5 HV-1 close — shared `<TaskActionDialog>` shell.
 *
 * Extracts the AlertDialog scaffold + footer (Cancel / Confirm with
 * spinner + busy-aria + disabled-while-pending) that was duplicated
 * across `done-task-dialog.tsx`, `skip-task-dialog.tsx`, and
 * `reassign-task-dropdown.tsx`. The body slot accepts arbitrary
 * children so each dialog keeps its own form fields + char counter +
 * combobox in the body — only the boilerplate is centralised.
 *
 * Net delta: ~−60 to −80 LOC across the 3 dialog files (per the
 * code-simplifier agent's HV-1 estimate). Concentrates the a11y
 * (`aria-busy`, `Loader2`, `disabled` on Cancel during submit) in
 * one place so future tightening lands once.
 *
 * Filename underscore prefix matches the existing `_components/`
 * private-folder convention.
 */
'use client';

import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
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

export interface TaskActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Called WHEN the dialog is closing (`open` prop becomes false).
   * Use to reset dialog-internal form state (textarea / combobox /
   * touched flag).
   *
   * R6 IMP-6 close — fires on BOTH:
   *   1. base-ui internal close (Escape, click outside) via
   *      `onOpenChange(false)`, AND
   *   2. parent flipping `open={false}` after a successful submit
   *      (via `useEffect` watching `open`). The earlier implementation
   *      only handled (1) — note state could leak between dialog
   *      sessions.
   */
  readonly onClose?: () => void;
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly submittingLabel: string;
  readonly isPending: boolean;
  /** Disables the confirm button when `false`. Cancel is always enabled (until pending). */
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
  /**
   * Confirm-button visual variant (R6 IMP-10 close).
   * `'destructive'` renders red for irreversible actions (Skip).
   * Default: regular primary button.
   */
  readonly variant?: 'default' | 'destructive';
  readonly children: React.ReactNode;
}

export function TaskActionDialog({
  open,
  onOpenChange,
  onClose,
  title,
  description,
  cancelLabel,
  confirmLabel,
  submittingLabel,
  isPending,
  canSubmit,
  onSubmit,
  variant = 'default',
  children,
}: TaskActionDialogProps) {
  // R6 IMP-6 close — fire onClose when the parent flips `open={false}`
  // (e.g. after a successful submit), in addition to base-ui's own
  // close events. Without this, dialog-internal form state (textarea
  // value, touched flag, selected combobox option) leaks across the
  // next dialog session — admin could submit the previous task's note
  // against a different task.
  useEffect(() => {
    if (!open) {
      onClose?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose?.();
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {children}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            disabled={isPending || !canSubmit}
            aria-busy={isPending}
            onClick={onSubmit}
          >
            {isPending && (
              <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            )}
            {isPending ? submittingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
