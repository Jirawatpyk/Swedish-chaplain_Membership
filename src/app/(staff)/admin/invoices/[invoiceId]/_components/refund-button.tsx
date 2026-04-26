'use client';

/**
 * T112 — Refund button entry component (F5 Phase 6 / US4).
 *
 * Thin client wrapper around `<RefundDialog>` so the server-rendered
 * invoice detail page can opt into the refund flow without crossing
 * the server/client boundary itself. The page passes typed payment
 * props down; this component owns the dialog mount + trigger.
 *
 * Trigger condition (caller-side / page-level): rendered ONLY when
 *   - actor.role === 'admin'
 *   - invoice.status ∈ {'paid', 'partially_credited'}
 *   - the invoice has at least one succeeded payment with remaining
 *     refundable balance > 0
 */
import { RefundDialog } from './refund-dialog';

type Props = {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly invoiceDocumentNumber: string;
  readonly memberCompanyName: string;
  readonly remainingRefundableSatang: bigint;
  readonly currencyCode: string;
};

export function RefundButton(props: Props) {
  return <RefundDialog {...props} />;
}
