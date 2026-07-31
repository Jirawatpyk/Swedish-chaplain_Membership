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
   * Called WHEN the dialog is closing (`open` prop transitions from
   * true → false), regardless of who initiated the close. Use to
   * reset dialog-internal form state (textarea / combobox / touched
   * flag).
   *
   * R6 IMP-6 + R8 C3-4 close — fires exactly ONCE per close, via a
   * `useRef`-guarded `useEffect`. The fix:
   *   1. Skips initial mount (`open=false` is the default state, not
   *      a close transition).
   *   2. Eliminates the prior double-fire on user-driven close
   *      (`onOpenChange(false)` + useEffect both ran the handler).
   *   Now `onClose` fires for both paths:
   *     - Base-ui internal close (Escape, click outside)
   *     - Parent flipping `open={false}` after successful submit
   *   ...via the single useEffect transition watcher.
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
  /**
   * UX-audit PR-A #5a — focus-return target on close (WCAG 2.1 AA SC 2.4.3).
   * These dialogs launch from a row's ⋯ `DropdownMenuItem` which unmounts on
   * select, and on a Done/Skip success the whole row unmounts too — Base UI's
   * default restore would then drop focus to `<body>`. Callers pass the
   * resolver built by `useDialogFinalFocus` (returns the ⋯ trigger on cancel,
   * #main-content when the row is gone). Optional — omitting it keeps Base UI's
   * default restore behaviour. Forwarded to the AlertDialog popup.
   *
   * Base UI reads its `returnFocus` (from this `finalFocus` prop) LIVE at close,
   * not snapshotted at open — so a nullable prop sourced from the dialog's own
   * open-state (`…DialogTarget?.finalFocus`) would already be `undefined` on the
   * close render and leave the whole focus-return chain inert. The always-mounted
   * lifted queue therefore passes a STABLE, always-defined callback that reads
   * the launching row's resolver from a ref (see `escalation-task-queue.tsx`
   * `activeFinalFocusRef`). `| undefined` stays explicit
   * (exactOptionalPropertyTypes) so callers may still omit the prop entirely.
   */
  readonly finalFocus?: (() => HTMLElement | null) | undefined;
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
  finalFocus,
  children,
}: TaskActionDialogProps) {
  // ux-standards § 7.2/§ 6.2: focus Cancel on open for dialogs with
  // side-effects (prefer safety default over convenience). Base UI's
  // FloatingFocusManager ignores `autoFocus`/`data-autofocus` — only
  // `initialFocus` on the Popup (AlertDialogContent) moves initial focus.
  // Pattern matches `src/components/shell/confirmation-dialog.tsx:81`.
  const cancelRef = useRef<HTMLButtonElement>(null);

  // R6 IMP-6 + R8 C3-4 close — fire onClose exactly once per close,
  // via a `wasOpen` ref-guarded `useEffect`. The ref skips initial
  // mount (when `open=false` is the default state, not a close
  // transition) and ensures both close paths (base-ui internal close
  // OR parent-flipped success path) trigger the same single handler.
  // The `onOpenChange` wrapper is now a clean pass-through — no
  // duplicate `onClose?.()` invocation.
  //
  // `onCloseRef` captures the latest `onClose` so callers passing
  // inline closures don't get a stale view.
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent initialFocus={cancelRef} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {children}

        <AlertDialogFooter>
          <AlertDialogCancel
            ref={cancelRef}
            disabled={isPending}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            disabled={isPending || !canSubmit}
            aria-busy={isPending}
            onClick={onSubmit}
          >
            {isPending && (
              <Loader2 className="mr-2 size-3.5 motion-safe:animate-spin" aria-hidden />
            )}
            {isPending ? submittingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
