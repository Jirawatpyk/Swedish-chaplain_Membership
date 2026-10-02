/**
 * Spec 122 US8 (T804) — Record payment on AURA's dialog (`Admin-record-payment`
 * board): the title and description, the summary box (which bill, whose,
 * the amount, the full-total note) and the form. Below 640px AURA's dialog is
 * a bottom sheet by itself (`Admin-record-payment-mobile`), so there is one
 * component for both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RecordPaymentDialog } from '@/app/(staff)/admin/invoices/_components/record-payment-dialog';

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy, push: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const pay = enMessages.admin.invoices.pay;

function renderDialog(extra: Partial<React.ComponentProps<typeof RecordPaymentDialog>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RecordPaymentDialog
        invoiceId="inv-1"
        documentNumber="SC-2026-000127"
        issueDate="2026-09-16"
        todayIso="2026-09-20"
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

describe('RecordPaymentDialog on AURA (T804)', () => {
  it('the trigger is an AURA button that keeps its id, test id and name', () => {
    renderDialog({ triggerAriaLabel: 'Record payment for invoice SC-2026-000127' });
    const trigger = screen.getByTestId('record-payment-trigger');
    expect(trigger).toHaveClass('aura-btn');
    expect(trigger).toHaveAttribute('id', 'record-payment');
    expect(trigger).toHaveAccessibleName('Record payment for invoice SC-2026-000127');
  });

  it('opens an AURA dialog titled "Record payment" with the board summary box', () => {
    renderDialog({ memberName: 'Baltic Bay Consulting Co., Ltd.', totalDisplay: '27,820.00 THB' });
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const dialog = screen.getByRole('dialog', { name: pay.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog).toHaveAccessibleDescription(pay.description);
    const summary = within(dialog).getByTestId('record-payment-document');
    expect(summary).toHaveTextContent('Recording payment for SC-2026-000127 · Baltic Bay Consulting Co., Ltd.');
    expect(summary).toHaveTextContent(pay.invoiceTotal);
    expect(summary).toHaveTextContent('27,820.00 THB');
    expect(summary).toHaveTextContent(pay.fullTotalNote);
  });

  it('without the member and total it still names the bill', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const summary = screen.getByTestId('record-payment-document');
    expect(summary).toHaveTextContent('Recording payment for SC-2026-000127');
    expect(summary).not.toHaveTextContent(pay.invoiceTotal);
  });

  it('holds the four fields and closes on Cancel', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const dialog = screen.getByRole('dialog', { name: pay.title });
    for (const label of [pay.fields.method, pay.fields.reference, pay.fields.date, pay.fields.notes]) {
      expect(within(dialog).getByLabelText(new RegExp(label))).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole('button', { name: pay.cancelDialog }));
    expect(screen.queryByRole('dialog', { name: pay.title })).toBeNull();
  });
});

describe('RecordPaymentDialog — review fixes (US8 T809)', () => {
  // `waitFor` polls on real timers; tests/setup.ts fakes them by default.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    refreshSpy.mockReset();
  });

  it('the summary labels the figure as the invoice total, not an amount received (WHT may be withheld)', () => {
    renderDialog({ memberName: 'Baltic Bay Consulting Co., Ltd.', totalDisplay: '27,820.00 THB' });
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const summary = screen.getByTestId('record-payment-document');
    expect(summary).toHaveTextContent('Invoice total (incl. VAT)');
    expect(summary).not.toHaveTextContent('Amount received');
  });

  it('cannot be dismissed with Escape while the payment is in flight', async () => {
    let settle: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => (settle = resolve)));
    renderDialog();
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const dialog = screen.getByRole('dialog', { name: pay.title });
    fireEvent.click(within(dialog).getByRole('button', { name: pay.submit }));
    // The POST starts synchronously inside the transition.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: pay.title })).toBeInTheDocument();
    await act(async () => {
      settle({ ok: false, json: async () => ({ error: { code: 'invoice_not_payable' } }) } as Response);
    });
  });

  it('after a successful payment the trigger unmounts and focus lands on the fallback, not <body>', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ receipt_document_number_raw: 'RC-2026-000001' }),
    } as Response);
    function Harness() {
      const [paid, setPaid] = useState(false);
      refreshSpy.mockImplementation(() => setPaid(true));
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <main id="main-content" tabIndex={-1} data-testid="main-content-stub" />
          <button type="button" id="row-menu-inv-1" data-testid="row-menu">
            ⋯
          </button>
          {paid ? null : (
            <RecordPaymentDialog
              invoiceId="inv-1"
              documentNumber="SC-2026-000127"
              issueDate="2026-09-16"
              todayIso="2026-09-20"
              finalFocusFallbackId="row-menu-inv-1"
            />
          )}
        </NextIntlClientProvider>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    fireEvent.click(screen.getByRole('button', { name: pay.submit }));
    await waitFor(() => expect(screen.queryByTestId('record-payment-trigger')).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(screen.getByTestId('row-menu'));
  });
});
