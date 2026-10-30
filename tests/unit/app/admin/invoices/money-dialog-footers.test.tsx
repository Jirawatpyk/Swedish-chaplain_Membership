/**
 * Spec 122 PR N2 (D-039) — the three staff money dialogs keep Cancel and their
 * confirm in AURA Dialog's `footer`, outside the scrolling body, so the
 * buttons are always in view. Below 640px AURA stacks the footer full width
 * with the primary action on top, which the hand-built sticky rows used to do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';
import { RefundForm } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form';
import { IssueInvoiceDialog } from '@/app/(staff)/admin/invoices/_components/issue-invoice-dialog';
import { RecordPaymentDialog } from '@/app/(staff)/admin/invoices/_components/record-payment-dialog';
import { RefundDialog, REFUND_FOOTER } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';
import { PaymentForm } from '@/app/(staff)/admin/invoices/_components/payment-form';
import { RECORD_PAYMENT_FOOTER } from '@/app/(staff)/admin/invoices/_components/record-payment-dialog';
import { WithMoneyDialogFooter } from '../../../../helpers/money-dialog-footer-harness';
import { buildIssueTotalsByTreatment } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/issue-totals-by-treatment';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshSpy, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

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

// PR N2 review (financial L2/L3, code review 1): each money handler guards
// itself against a second call in the same tick, before React re-renders the
// footer into its loading state.
describe('a second submit in the same tick sends nothing', () => {
  type Call = [string, RequestInit | undefined];
  const posts = (spy: ReturnType<typeof vi.fn>) =>
    (spy.mock.calls as unknown as Call[]).filter(([, init]) => init?.method === 'POST');

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('issue invoice: two confirm clicks before a re-render issue once', async () => {
    let settle: (r: Response) => void = () => {};
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal('fetch', fetchSpy);
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
    const dialog = screen.getByRole('alertdialog', { name: issue.title });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'ISSUE' } });
    const confirm = within(dialog).getByRole('button', { name: 'Issue invoice · 8,560.00 THB' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(posts(fetchSpy)).toHaveLength(1);
    await act(async () => {
      settle({ ok: false, json: async () => ({ error: { code: 'invoice_not_draft' } }) } as Response);
    });
    vi.unstubAllGlobals();
  });

  it('record payment: two submits before a re-render record once', async () => {
    let settle: (r: Response) => void = () => {};
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal('fetch', fetchSpy);
    withIntl(
      <RecordPaymentDialog invoiceId="inv-1" documentNumber="SC-2026-000127" issueDate="2026-09-16" todayIso="2026-09-20" />,
    );
    fireEvent.click(screen.getByTestId('record-payment-trigger'));
    const form = screen.getByRole('dialog', { name: pay.title }).querySelector('form')!;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(posts(fetchSpy)).toHaveLength(1);
    await act(async () => {
      settle({ ok: false, json: async () => ({ error: { code: 'invoice_not_payable' } }) } as Response);
    });
    vi.unstubAllGlobals();
  });

  function openRefund(fetchSpy: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchSpy);
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
    return screen.getByRole('alertdialog', { name: refund.title });
  }

  async function fillPartialRefund(dialog: HTMLElement) {
    fireEvent.change(within(dialog).getByTestId('refund-form-amount'), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByTestId('refund-form-reason'), { target: { value: 'duplicate charge' } });
    fireEvent.blur(within(dialog).getByTestId('refund-form-reason'));
    const confirm = within(dialog).getByTestId('refund-form-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    return confirm;
  }

  // The refund route's POST stays pending; the preview GET answers at once.
  function refundFetch() {
    let settle: (r: Response) => void = () => {};
    const spy = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => (settle = resolve))
        : Promise.resolve(new Response(JSON.stringify({ creditNote: { kind: 'blocked' } }))),
    );
    return { spy, settle: (r: Response) => settle(r) };
  }

  it('refund: two submits while validation runs send one refund', async () => {
    const { spy, settle } = refundFetch();
    const dialog = openRefund(spy);
    await fillPartialRefund(dialog);
    const form = dialog.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(posts(spy)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(spy)).toHaveLength(1);
    await act(async () => {
      settle(new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }));
    });
    vi.unstubAllGlobals();
  });

  it('refund: a submit that fails validation does not hold the guard', async () => {
    const { spy, settle } = refundFetch();
    const dialog = openRefund(spy);
    const form = dialog.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(posts(spy)).toHaveLength(0);
    await fillPartialRefund(dialog);
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(posts(spy)).toHaveLength(1));
    await act(async () => {
      settle(new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }));
    });
    vi.unstubAllGlobals();
  });

  // Code review 2: the gate can turn false while the refund is in flight; the
  // confirm stays AURA's loading button, never natively disabled.
  it('refund: clearing the reason in flight keeps the confirm focused and busy', async () => {
    const { spy, settle } = refundFetch();
    const dialog = openRefund(spy);
    const confirm = await fillPartialRefund(dialog);
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    fireEvent.change(within(dialog).getByTestId('refund-form-reason'), { target: { value: '' } });
    fireEvent.blur(within(dialog).getByTestId('refund-form-reason'));
    await new Promise((r) => setTimeout(r, 50));
    expect(confirm).not.toBeDisabled();
    expect(confirm).toHaveFocus();
    await act(async () => {
      settle(new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }));
    });
    vi.unstubAllGlobals();
  });
});

// Code review 4: a form that unmounts in flight (its success close) leaves
// the footer idle, so however the dialog opens next, Cancel is enabled.
describe('the footer goes idle when its form unmounts', () => {
  it('a form unmounted while in flight leaves Cancel enabled', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    function Host() {
      const [show, setShow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShow(false)}>
            unmount
          </button>
          <WithMoneyDialogFooter config={RECORD_PAYMENT_FOOTER}>
            {(wire) =>
              show ? (
                <PaymentForm invoiceId="inv-1" documentNumber="SC-1" issueDate="2026-09-16" todayIso="2026-09-20" {...wire} />
              ) : null
            }
          </WithMoneyDialogFooter>
        </>
      );
    }
    withIntl(<Host />);
    fireEvent.click(screen.getByRole('button', { name: pay.submit }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'unmount' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    vi.unstubAllGlobals();
  });
});

// Financial review L3 (PR #703): once the server may have refunded (any 2xx,
// or a request whose fate is unknown), the dialog never offers a retry: a
// retry after a synchronous refund would pay a second partial refund.
describe('refund: no retry once the outcome may be a refund', () => {
  type Call = [string, RequestInit | undefined];
  const posts = (spy: ReturnType<typeof vi.fn>) =>
    (spy.mock.calls as unknown as Call[]).filter(([, init]) => init?.method === 'POST');
  const preview = () => Promise.resolve(new Response(JSON.stringify({ creditNote: { kind: 'blocked' } })));

  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(toast.warning).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.info).mockReset();
    refreshSpy.mockClear();
  });

  async function submitPartial(postImpl: () => Promise<Response>) {
    const spy = vi.fn((_url: string, init?: RequestInit) => (init?.method === 'POST' ? postImpl() : preview()));
    vi.stubGlobal('fetch', spy);
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
    fireEvent.change(within(dialog).getByTestId('refund-form-amount'), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByTestId('refund-form-reason'), { target: { value: 'duplicate charge' } });
    fireEvent.blur(within(dialog).getByTestId('refund-form-reason'));
    const confirm = within(dialog).getByTestId('refund-form-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    return spy;
  }

  async function expectClosedWithWarning(
    spy: ReturnType<typeof vi.fn>,
    message: string,
    { refreshed = true }: { refreshed?: boolean } = {},
  ) {
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    if (refreshed) expect(refreshSpy).toHaveBeenCalled();
    else expect(refreshSpy).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(message);
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId('refund-form-error')).toBeNull();
    expect(posts(spy)).toHaveLength(1);
    vi.unstubAllGlobals();
  }

  it('a 201 whose body cannot be read closes, refreshes and warns', async () => {
    const spy = await submitPartial(async () => new Response('<html>gateway</html>', { status: 201 }));
    await expectClosedWithWarning(spy, enMessages.admin.refund.success.unconfirmedToast);
  });

  it('a 201 without a refund in its body closes, refreshes and warns', async () => {
    const spy = await submitPartial(async () => new Response('{}', { status: 201 }));
    await expectClosedWithWarning(spy, enMessages.admin.refund.success.unconfirmedToast);
  });

  // R112 §3: with the connection still down, a refresh falls back to a browser
  // navigation onto the offline page and the warning is lost, so it doesn't.
  it('a request that fails on the network closes and warns to check first, without a refresh', async () => {
    const spy = await submitPartial(() => Promise.reject(new TypeError('Failed to fetch')));
    await expectClosedWithWarning(spy, enMessages.admin.refund.error.outcomeUnknown, { refreshed: false });
  });

  // Financial review M1: a 5xx that names no refusal (our internal_error, or
  // no readable code: an edge timeout) may have refunded; no retry.
  it('a 500 internal_error closes, refreshes and warns', async () => {
    const spy = await submitPartial(async () =>
      new Response(JSON.stringify({ error: { code: 'internal_error' } }), { status: 500 }),
    );
    await expectClosedWithWarning(spy, enMessages.admin.refund.error.outcomeUnknown);
  });

  it('a 504 with no readable body closes, refreshes and warns', async () => {
    const spy = await submitPartial(async () => new Response('<html>timeout</html>', { status: 504 }));
    await expectClosedWithWarning(spy, enMessages.admin.refund.error.outcomeUnknown);
  });

  // Financial review L4: telling the admin what happened can't turn a refund
  // that went through into a retry.
  it('a 201 whose success toast throws closes, refreshes and warns', async () => {
    vi.mocked(toast.success).mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    const spy = await submitPartial(async () =>
      new Response(
        JSON.stringify({ refund: { status: 'succeeded', creditNote: { kind: 'issued', id: 'cn', number: 'CN-1' } } }),
        { status: 201 },
      ),
    );
    await expectClosedWithWarning(spy, enMessages.admin.refund.success.unconfirmedToast);
  });

  // Financial review L1: even if the warning itself throws, the dialog closes
  // and offers no retry.
  it('if the warning toast throws, the dialog still closes with no retry', async () => {
    vi.mocked(toast.warning).mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    const spy = await submitPartial(() => Promise.reject(new TypeError('Failed to fetch')));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(posts(spy)).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  // Code review (PR #703): the write freeze answers 503 with a flat
  // `{ error: 'read-only-mode' }`; nothing ran, so it is said as such.
  it('the read-only 503 says the write freeze, keeps the dialog and is not unconfirmed', async () => {
    const spy = await submitPartial(async () => new Response(JSON.stringify({ error: 'read-only-mode' }), { status: 503 }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(enMessages.errors.readOnlyMode);
    expect(screen.getByRole('alertdialog', { name: refund.title })).toBeInTheDocument();
    expect(posts(spy)).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  // Code review: a failing membership-outcome toast after the success toast
  // must not add a contradicting "couldn't read the result" warning.
  it('a throwing membership-outcome toast after a success adds no unconfirmed warning', async () => {
    vi.mocked(toast.info).mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    await submitPartial(async () =>
      new Response(
        JSON.stringify({
          membership_end: 'ended',
          refund: { status: 'succeeded', creditNote: { kind: 'issued', id: 'cn', number: 'CN-1' } },
        }),
        { status: 201 },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast.success).toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a refused request (429) still shows the error and can be retried', async () => {
    const spy = await submitPartial(async () => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }));
    await waitFor(() => expect(screen.getByTestId('refund-form-error')).toBeInTheDocument());
    const confirm = screen.getByTestId('refund-form-confirm');
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(spy)).toHaveLength(2));
    vi.unstubAllGlobals();
  });

  // Financial review L1: after a success the guard stays held, as in issue
  // and record payment, even if the form were still mounted.
  it('after a refund succeeds, the still-mounted form sends nothing more', async () => {
    const spy = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(
            new Response(
              JSON.stringify({ refund: { status: 'succeeded', creditNote: { kind: 'issued', id: 'cn', number: 'CN-1' } } }),
              { status: 201 },
            ),
          )
        : preview(),
    );
    vi.stubGlobal('fetch', spy);
    const { container } = withIntl(
      <WithMoneyDialogFooter config={REFUND_FOOTER}>
        {(wire) => (
          <RefundForm
            paymentId="pmt_1"
            invoiceId="inv_1"
            memberCompanyName="Acme AB"
            remainingRefundableSatang={3_852_000n}
            currencyCode="THB"
            invoiceSubject="event"
            invoiceHeadroomSatang={3_852_000n}
            onClose={() => undefined}
            {...wire}
          />
        )}
      </WithMoneyDialogFooter>,
    );
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '100' } });
    fireEvent.change(screen.getByTestId('refund-form-reason'), { target: { value: 'duplicate charge' } });
    fireEvent.blur(screen.getByTestId('refund-form-reason'));
    const confirm = screen.getByTestId('refund-form-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(spy)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
