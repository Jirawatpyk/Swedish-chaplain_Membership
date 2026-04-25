'use client';

/**
 * <ProcessingPanel> — "Processing payment…" state shown when the Stripe
 * PaymentIntent returns `status === 'processing'` after confirm.
 *
 * Simplify S2: implementation lives in the shared `<StatusPanel>`;
 * this file is a thin wrapper that pins `kind="processing"` so the
 * caller import path + testids stay stable.
 */
import { StatusPanel } from './status-panel';

export interface ProcessingPanelProps {
  readonly onCancel: () => void;
}

export function ProcessingPanel({ onCancel }: ProcessingPanelProps) {
  return <StatusPanel kind="processing" onCancel={onCancel} />;
}

export default ProcessingPanel;
