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

import { useEffect, useRef } from 'react';
import { Button, Dialog } from '@jirawatpyk/aura-react';

export interface TaskActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Called WHEN the dialog is closing (`open` goes true → false), whoever
   * closed it. Use it to reset the dialog's own form state.
   *
   * R6 IMP-6 + R8 C3-4 close — fires exactly ONCE per close, via a
   * ref-guarded effect: not on the initial mount, and not twice when a
   * user close is followed by the parent's `open={false}`.
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
  /** `'destructive'` uses the danger button for irreversible actions (Skip). */
  readonly variant?: 'default' | 'destructive';
  /**
   * UX-audit PR-A #5a — where focus goes on close (WCAG 2.1 AA SC 2.4.3). The
   * queue passes one stable resolver: the control that opened the dialog on
   * Cancel, `#main-content` once a success has unmounted the row. AURA reads
   * it at close, so it must stay defined while the dialog closes.
   */
  readonly finalFocus?: (() => HTMLElement | null) | undefined;
  readonly children: React.ReactNode;
}

/**
 * 122 US7b-2 (T733) — the shared shell of the Done / Skip / Reassign confirms,
 * on AURA's `Dialog role="alertdialog"`. Cancel takes the initial focus
 * (ux-standards § 7.2: the safe default for an action with side effects); the
 * confirm shows its submitting label while the request runs, and the dialog
 * cannot be dismissed meanwhile (§ 6.4).
 */
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
  finalFocus,
  children,
}: TaskActionDialogProps) {
  // Fire onClose once per close edge; the latest closure is read through a ref
  // so callers can pass inline functions.
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      onCloseRef.current?.();
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      role="alertdialog"
      dismissible={!isPending}
      {...(finalFocus ? { finalFocus } : {})}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" data-autofocus="" disabled={isPending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'danger' : 'primary'}
            loading={isPending}
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {isPending ? submittingLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
