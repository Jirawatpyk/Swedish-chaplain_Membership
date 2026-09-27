'use client';

/**
 * `<PayBar>` — the amount-due + Pay now bar (spec 122 US4,
 * `Portal-invoice-mobile`). It hides the instant PaySheet dispatches the
 * optimistic-paid signal, so the header's "Paid" badge never sits above a
 * stale "Amount due ฿…" while the webhook and `router.refresh()` catch up.
 *
 * It HIDES rather than unmounts: `PayNowButton` inside it roots the pay
 * sheet, whose confirmation panel is still on screen (R7 — unmounting kills
 * it mid-render). The drawer portals to `document.body`, so `hidden` here
 * does not hide it. No `onCrossTabPaid` — `OptimisticPaidOverlay` owns the
 * page's single cross-tab refresh.
 */
import { useOptimisticPaid } from './optimistic-paid';

export interface PayBarProps {
  readonly invoiceId: string;
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export function PayBar({ invoiceId, label, className, children }: PayBarProps) {
  const paid = useOptimisticPaid(invoiceId);
  return (
    <section aria-label={label} data-testid="portal-invoice-pay-bar" hidden={paid} className={className}>
      {children}
    </section>
  );
}
