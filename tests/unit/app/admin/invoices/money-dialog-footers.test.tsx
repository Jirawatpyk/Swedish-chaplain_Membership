/**
 * Spec 122 PR N2 (D-039) — the three staff money dialogs keep Cancel and their
 * confirm in AURA Dialog's `footer`, outside the scrolling body, so the
 * buttons are always in view. Below 640px AURA stacks the footer full width
 * with the primary action on top, which the hand-built sticky rows used to do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { IssueInvoiceDialog } from '@/app/(staff)/admin/invoices/_components/issue-invoice-dialog';
import { RecordPaymentDialog } from '@/app/(staff)/admin/invoices/_components/record-payment-dialog';
import { RefundDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';
import { buildIssueTotalsByTreatment } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/issue-totals-by-treatment';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const issue = enMessages.admin.invoices.issue;
const pay = enMessages.admin.invoices.pay;
const refund = enMessages.admin.refund.dialog;

const foot = (el: HTMLElement) => el.closest('.aura-dialog__foot');
const body = (el: HTMLElement) => el.closest('.aura-dialog__body');

function withIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('IssueInvoiceDialog — buttons in the Dialog footer', () => {
  function open() {
    withIntl(
      <IssueInvoiceDialog
        invoiceId="inv-1"
        summary={{ memberName: 'Embassy of Sweden', planDisplayName: 'Expo booth', planYear: 2026 }}
        taxAtPayment
        isMembership
        buyerIsVatRegistrant
        totalsByTreatment={buildIssueTotalsByTreatment({
          lineSum: Money.fromSatangUnsafe(800_000),
          vatInclusive: false,
          standardRate: VatRate.ofUnsafe('0.0700'),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue…' }));
    return screen.getByRole('alertdialog', { name: issue.title });
  }

  it('Cancel (first focus) and the confirm, naming the total, sit in the footer, not the body', () => {
    const dialog = open();
    const cancel = within(dialog).getByRole('button', { name: issue.cancel });
    const confirm = within(dialog).getByRole('button', { name: 'Issue invoice · 8,560.00 THB' });
    for (const button of [cancel, confirm]) {
      expect(foot(button)).not.toBeNull();
      expect(body(button)).toBeNull();
    }
    expect(cancel).toHaveFocus();
  });

  it('the confirm stays disabled until the phrase matches, and Enter in the phrase never issues', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const dialog = open();
    const confirm = within(dialog).getByRole('button', { name: 'Issue invoice · 8,560.00 THB' });
    expect(confirm).toBeDisabled();
    const phrase = within(dialog).getByLabelText(/to confirm/i);
    fireEvent.change(phrase, { target: { value: 'ISSUE' } });
    expect(confirm).toBeEnabled();
    fireEvent.keyDown(phrase, { key: 'Enter' });
    fireEvent.submit(phrase);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Financial-integrity review: the shell reads `pending` from the footer state.
  it('while the issue POST is in flight, Escape does not close it, Cancel is disabled, a second click sends nothing', async () => {
    vi.useRealTimers();
    let settle: (r: Response) => void = () => {};
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal('fetch', fetchSpy);
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'ISSUE' } });
    const confirm = within(dialog).getByRole('button', { name: 'Issue invoice · 8,560.00 THB' });
    confirm.focus();
    fireEvent.click(confirm);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(confirm);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: issue.cancel })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: issue.title })).toBeInTheDocument();
    await act(async () => {
      settle({ ok: false, json: async () => ({ error: { code: 'invoice_not_draft' } }) } as Response);
    });
    vi.unstubAllGlobals();
  });

  it('Cancel in the footer closes the dialog', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: issue.cancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('RefundDialog — buttons in the Dialog footer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ creditNote: { kind: 'blocked' } }))));
  });

  it('Cancel (first focus) and the confirm sit in the footer; the confirm submits the refund form', () => {
    withIntl(
      <RefundDialog
        paymentId="pmt_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={3_852_000n}
        currencyCode="THB"
        invoiceSubject="event"
        invoiceHeadroomSatang={3_852_000n}
        invoiceDocumentNumber="SC-2026-000088"
        receiptDocumentNumberRaw="RC-2026-000088"
        paidAmountSatang={3_852_000n}
        paidAt="2026-02-01T03:00:00.000Z"
      />,
    );
    fireEvent.click(screen.getByTestId('refund-dialog-trigger'));
    const dialog = screen.getByRole('alertdialog', { name: refund.title });
    const cancel = within(dialog).getByRole('button', { name: refund.cancel });
    const confirm = within(dialog).getByTestId('refund-form-confirm');
    for (const button of [cancel, confirm]) {
      expect(foot(button)).not.toBeNull();
      expect(body(button)).toBeNull();
    }
    expect(cancel).toHaveFocus();
    // The confirm is the refund form's own submit button, from outside it.
    expect(confirm).toHaveAttribute('type', 'submit');
    expect((confirm as HTMLButtonElement).form).toBe(dialog.querySelector('form'));
  });
});

describe('RecordPaymentDialog — buttons in the Dialog footer', () => {
  it('Cancel and Record payment sit in the footer; Record payment submits the payment form', () => {
    withIntl(
      <RecordPaymentDialog invoiceId="inv-1" documentNumber="SC-2026-000127" issueDate="2026-09-16" todayIso="2026-09-20" />,
    );
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const dialog = screen.getByRole('dialog', { name: pay.title });
    const cancel = within(dialog).getByRole('button', { name: pay.cancelDialog });
    const submit = within(dialog).getByRole('button', { name: pay.submit });
    for (const button of [cancel, submit]) {
      expect(foot(button)).not.toBeNull();
      expect(body(button)).toBeNull();
    }
    expect(submit).toHaveAttribute('type', 'submit');
    expect((submit as HTMLButtonElement).form).toBe(dialog.querySelector('form'));
    // Its first focus is still the first field, not Cancel.
    expect(cancel).not.toHaveFocus();
  });
});

// Mobile/a11y review (PR N2, M1): while the request is in flight the confirm
// is AURA's loading button (aria-busy, aria-disabled, the click swallowed),
// never natively disabled, so it keeps focus inside the modal and a screen
// reader hears its in-flight label.
describe('the confirm keeps focus while the request is in flight', () => {
  it('Record payment stays focused and busy, not disabled, until the POST settles', async () => {
    vi.useRealTimers();
    let settle: (r: Response) => void = () => {};
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal('fetch', fetchSpy);
    withIntl(
      <RecordPaymentDialog invoiceId="inv-1" documentNumber="SC-2026-000127" issueDate="2026-09-16" todayIso="2026-09-20" />,
    );
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const dialog = screen.getByRole('dialog', { name: pay.title });
    const submit = within(dialog).getByRole('button', { name: pay.submit });
    submit.focus();
    fireEvent.click(submit);
    const busy = within(dialog).getByRole('button', { name: pay.submitting });
    expect(busy).toBe(submit);
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveFocus();
    // A second click while busy sends nothing more.
    fireEvent.click(busy);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ ok: false, json: async () => ({ error: { code: 'invoice_not_payable' } }) } as Response);
    });
    vi.unstubAllGlobals();
  });
});
