'use client';

/**
 * Spec 122 PR N2 (D-039) — the buttons of the staff money dialogs (issue
 * invoice, refund, record payment), drawn in AURA Dialog's `footer`: outside
 * the scrolling body, so a long form never scrolls them away; below 640px
 * AURA stacks them full width with the primary action on top.
 *
 * The Dialog lives in each shell and the state the buttons show lives in its
 * form, so the form reports it with `useReportMoneyDialogFooter` and the shell
 * renders this footer. Each money handler, guard and label stays in its form.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, type IconName } from '@jirawatpyk/aura-react';

export type MoneyDialogFooterState = {
  /** The request is in flight: Cancel is disabled and the confirm spins. */
  readonly pending: boolean;
  /** The form's own gate (typed phrase, valid amount); never true while pending. */
  readonly canConfirm: boolean;
  /** The form's label for the confirm, e.g. the total it names. */
  readonly confirmLabel: string;
  /**
   * The confirm runs this on click instead of submitting the form (issue
   * invoice: Enter in its phrase field must never mint a tax document).
   */
  readonly onConfirm?: () => void;
};

export function initialMoneyDialogFooter(confirmLabel: string): MoneyDialogFooterState {
  return { pending: false, canConfirm: false, confirmLabel };
}

/**
 * Reports the footer state from a form before paint, so the footer never
 * draws a stale label or gate. `onConfirm` may change every render; the
 * reported one is a stable wrapper that runs the latest.
 */
export function useReportMoneyDialogFooter(
  onFooterChange: ((state: MoneyDialogFooterState) => void) | undefined,
  { pending, canConfirm, confirmLabel, onConfirm }: MoneyDialogFooterState,
): void {
  const confirmRef = useRef(onConfirm);
  useEffect(() => {
    confirmRef.current = onConfirm;
  });
  const [stableConfirm] = useState(() => () => confirmRef.current?.());
  const hasConfirm = onConfirm !== undefined;
  useLayoutEffect(() => {
    onFooterChange?.({
      pending,
      canConfirm: canConfirm && !pending,
      confirmLabel,
      ...(hasConfirm ? { onConfirm: stableConfirm } : {}),
    });
  }, [onFooterChange, pending, canConfirm, confirmLabel, hasConfirm, stableConfirm]);
}

/** What each dialog fixes about its buttons; exported from its shell. */
export type MoneyDialogFooterConfig = {
  readonly confirmVariant: 'primary' | 'danger';
  readonly confirmIcon: IconName;
  readonly confirmTestId?: string;
  /** Cancel takes the first focus (ux-standards § 6, the safe action). */
  readonly autoFocusCancel?: boolean;
};

export function MoneyDialogFooter({
  state,
  formId,
  cancelLabel,
  onCancel,
  confirmVariant,
  confirmIcon,
  confirmTestId,
  autoFocusCancel = false,
}: MoneyDialogFooterConfig & {
  readonly state: MoneyDialogFooterState;
  /** The form the confirm submits; unused when the state carries `onConfirm`. */
  readonly formId?: string;
  readonly cancelLabel: string;
  readonly onCancel: () => void;
}) {
  const { pending, canConfirm, confirmLabel, onConfirm } = state;
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        fullWidth="below-sm"
        {...(autoFocusCancel ? { 'data-autofocus': true } : {})}
        disabled={pending}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      {/* Full width below sm, so a label that names the total wraps at 320px
          instead of running out of the button. */}
      <Button
        {...(onConfirm ? { type: 'button' as const, onClick: onConfirm } : { type: 'submit' as const, form: formId })}
        variant={confirmVariant}
        fullWidth="below-sm"
        icon={confirmIcon}
        loading={pending}
        disabled={!canConfirm || pending}
        {...(confirmTestId ? { 'data-testid': confirmTestId } : {})}
      >
        {confirmLabel}
      </Button>
    </>
  );
}
