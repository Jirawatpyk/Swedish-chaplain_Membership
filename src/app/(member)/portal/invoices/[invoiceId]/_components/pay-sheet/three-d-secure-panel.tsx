'use client';

/**
 * <ThreeDSecurePanel> — in-drawer placeholder rendered while the Stripe
 * PaymentIntent is in `requires_action` state (issuing-bank 3DS challenge).
 *
 * Simplify S2: implementation lives in the shared `<StatusPanel>`;
 * this file is a thin wrapper that pins `kind="three-d-secure"`.
 *
 * Polling contract (owned by the parent <PaySheetInternal>): see
 * `useThreeDSecurePoll` — `stripe.retrievePaymentIntent` every 2 s up
 * to 5 min; on `succeeded` → <ConfirmationPanel>; on `canceled` /
 * `requires_payment_method` → retry panel.
 */
import { StatusPanel } from './status-panel';

export interface ThreeDSecurePanelProps {
  readonly onCancel: () => void;
}

export function ThreeDSecurePanel({ onCancel }: ThreeDSecurePanelProps) {
  return <StatusPanel kind="three-d-secure" onCancel={onCancel} />;
}

export default ThreeDSecurePanel;
