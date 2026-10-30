/**
 * Spec 122 PR N2 — a money form (issue invoice, refund, record payment) renders
 * no buttons of its own: its dialog shell draws them in AURA Dialog's footer
 * from the state the form reports. A test that renders the form alone wraps it
 * here to get the same buttons, with the shell's own footer config.
 */
import { useId, useState, type ReactNode } from 'react';
import {
  initialMoneyDialogFooter,
  MoneyDialogFooter,
  type MoneyDialogFooterConfig,
  type MoneyDialogFooterState,
} from '@/app/(staff)/admin/invoices/_components/money-dialog-footer';

export function WithMoneyDialogFooter({
  config,
  cancelLabel = 'Cancel',
  onCancel = () => undefined,
  children,
}: {
  readonly config: MoneyDialogFooterConfig;
  readonly cancelLabel?: string;
  readonly onCancel?: () => void;
  readonly children: (wire: {
    readonly formId: string;
    readonly onFooterChange: (state: MoneyDialogFooterState) => void;
  }) => ReactNode;
}) {
  const formId = useId();
  const [state, setState] = useState(() => initialMoneyDialogFooter(''));
  return (
    <>
      {children({ formId, onFooterChange: setState })}
      <div data-testid="money-dialog-footer">
        <MoneyDialogFooter {...config} state={state} formId={formId} cancelLabel={cancelLabel} onCancel={onCancel} />
      </div>
    </>
  );
}
