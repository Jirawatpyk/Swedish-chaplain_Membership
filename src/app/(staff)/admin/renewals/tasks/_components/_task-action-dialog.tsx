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
   * Called WHEN the dialog is closing (next === false). Use to reset
   * dialog-internal form state (textarea / combobox / touched flag).
   * Distinct from `onOpenChange` which fires for both open and close.
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
  /** Renders the confirm button with the destructive variant (red). */
  readonly destructive?: boolean;
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
  destructive = false,
  children,
}: TaskActionDialogProps) {
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
            {...(destructive ? { variant: 'destructive' as const } : {})}
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
