'use client';

/**
 * ConfirmationDialog on AURA `Dialog role="alertdialog"` (T134,
 * ux-standards § 6; spec 122 US1 — the props are unchanged).
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
import { Children, useEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import { Button, Dialog } from '@jirawatpyk/aura-react';

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
  /**
   * 107-auto-invoice Task 14 review — focus-return target on close.
   * OPTIONAL escape hatch for callers whose trigger button is NOT
   * guaranteed to survive a successful action (e.g. a per-row "⋯" menu
   * whose row leaves the list on `router.refresh()` — Discard is a hard
   * DELETE; Issue flips the row out of a `status='draft'` filtered view).
   * Without this, Base UI's default focus-return targets the ORIGINAL
   * trigger element; if that element has since unmounted, focus silently
   * drops to `<body>` — a keyboard/SR user must re-Tab from the top of the
   * page after every single action, which is unacceptable in a row-by-row
   * batch workflow (AURA returns focus to the trigger the same way). Build
   * via `useDialogFinalFocus`
   * (`@/components/broadcast/reason-confirmation-dialog` — reused
   * verbatim, not reimplemented; the hook + its resolver are dialog-
   * agnostic despite living in the broadcast feature folder). Omit for the
   * common case where the trigger reliably survives every close path
   * (AURA's own default — return the trigger — applies).
   */
  readonly finalFocus?: () => HTMLElement | false | null;
  /**
   * F114 review (UX I3) — where focus lands on open. Defaults to Cancel
   * (ux-standards § 6); a dialog whose body carries a REQUIRED input (a
   * reject reason) passes that input's ref so the keyboard user starts on the
   * one thing that unblocks Confirm instead of Shift+Tabbing back to it.
   */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Spec 122 — `false`: only the dialog's own buttons close it; Escape, the
   * scrim and AURA's × do nothing. For a view whose content cannot be shown
   * again (a one-time secret), where one stray click would lose it for good.
   * Default true.
   */
  readonly dismissible?: boolean;
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
  finalFocus,
  initialFocusRef,
  dismissible = true,
}: ConfirmationDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  // AURA's modal focuses `[data-autofocus]` (Cancel — ux-standards § 6
  // "safest default") on open. This runs after it (a parent's effects follow
  // its child's), so a caller's required field takes the first focus instead.
  useEffect(() => {
    if (open && initialFocusRef?.current) initialFocusRef.current.focus();
  }, [open, initialFocusRef]);

  // AURA returns focus to the trigger on close. A caller whose trigger may
  // be gone by then (its row left the list) names where focus goes instead.
  // This runs in the cleanup of the render that was OPEN — so it fires on
  // every way out: this dialog's own close, the caller closing it
  // (`closeOnConfirm={false}`), and the caller unmounting it together with
  // its row.
  const finalFocusRef = useRef(finalFocus);
  useEffect(() => {
    finalFocusRef.current = finalFocus;
  }, [finalFocus]);
  useEffect(() => {
    if (!open) return undefined;
    return () => {
      // Resolved NOW, while the caller's refs still say whether the trigger
      // survives; applied a microtask later, after AURA's own restore has
      // run in this same commit. Never pulled out of a dialog that is open.
      const target = finalFocusRef.current?.();
      if (!target) return;
      queueMicrotask(() => {
        if (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return;
        target.focus();
      });
    };
  }, [open]);

  function close(): void {
    onOpenChange(false);
  }

  async function handleConfirmClick(): Promise<void> {
    if (confirmDisabled || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err: unknown) {
      console.error('[ConfirmationDialog] onConfirm rejected', err);
      queueMicrotask(() => {
        throw err;
      });
    } finally {
      setSubmitting(false);
      if (closeOnConfirm) close();
    }
  }

  return (
    <Dialog
      role="alertdialog"
      open={open}
      onClose={close}
      // No Escape / scrim close while the action runs (Cancel is disabled too).
      dismissible={dismissible && !submitting}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" data-autofocus disabled={submitting} onClick={close}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={submitting}
            disabled={confirmDisabled || submitting}
            aria-disabled={confirmDisabled || submitting || undefined}
            onClick={() => {
              void handleConfirmClick();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {/* F114 review (UX I2) — bound the BODY, not the dialog, so a tall body
          on a short viewport never pushes Cancel / Confirm off-screen. */}
      {Children.toArray(children).length > 0 ? <div className="max-h-[50vh] space-y-4 overflow-y-auto">{children}</div> : null}
    </Dialog>
  );
}
