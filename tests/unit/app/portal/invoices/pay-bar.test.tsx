/**
 * Spec 122 US4 (financial review M1) — the amount-due bar hides the moment
 * the pay sheet signals optimistic paid, so the page never shows "Paid" in
 * the header beside "Amount due ฿…" below. It hides rather than unmounts:
 * `PayNowButton` inside it roots the pay sheet, whose confirmation panel is
 * still on screen (R7).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PayBar } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-bar';
import { dispatchInvoicePaid } from '@/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid';

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('<PayBar>', () => {
  it('hides once the invoice is optimistically paid, keeping its children mounted', () => {
    render(
      <PayBar invoiceId="inv-paybar-1" label="Amount due" className="sticky">
        <span>฿38,520.00</span>
        <button type="button">Pay now</button>
      </PayBar>,
    );
    const bar = screen.getByTestId('portal-invoice-pay-bar');
    expect(bar).toBeVisible();
    expect(bar).toHaveAccessibleName('Amount due');

    act(() => dispatchInvoicePaid('inv-paybar-1'));

    expect(bar).not.toBeVisible();
    expect(bar).toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Pay now', hidden: true })).toBeInTheDocument();
  });

  it('ignores a paid signal for another invoice', () => {
    render(
      <PayBar invoiceId="inv-paybar-2" label="Amount due">
        <span>x</span>
      </PayBar>,
    );
    act(() => dispatchInvoicePaid('inv-other'));
    expect(screen.getByTestId('portal-invoice-pay-bar')).not.toHaveAttribute('hidden');
  });
});
