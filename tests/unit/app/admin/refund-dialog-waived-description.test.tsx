/**
 * Spec 122 US8b follow-up — the refund dialog's description must not promise
 * a credit note F4 will not issue. When the page already knows the document
 * is waived (a section 105 receipt, a voided invoice), the description says so
 * from the moment the dialog opens, and the summary's "No credit note" line
 * shows without a preview read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('refund=1'),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ creditNote: { kind: 'blocked' } })));

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

function renderDialog(creditNoteWaiverReason?: 'section_105_receipt' | 'invoice_voided' | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RefundDialog
        paymentId="pmt_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={3_852_000n}
        currencyCode="THB"
        invoiceSubject="event"
        invoiceHeadroomSatang={3_852_000n}
        invoiceDocumentNumber="SC-2026-000088"
        receiptDocumentNumberRaw="RE-2026-000007"
        paidAmountSatang={3_852_000n}
        paidAt="2026-02-01T03:00:00.000Z"
        {...(creditNoteWaiverReason !== undefined ? { creditNoteWaiverReason } : {})}
      />
    </NextIntlClientProvider>,
  );
}

describe('RefundDialog — description follows the credit-note verdict', () => {
  it('an ordinary invoice keeps the credit-note promise', () => {
    renderDialog(null);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(enMessages.admin.refund.dialog.description);
  });

  it.each([
    ['section_105_receipt', 'Refund all or part of this payment. No credit note is issued: this payment has a Section 105 receipt, not a tax invoice.'],
    ['invoice_voided', 'Refund all or part of this payment. No credit note is issued: this invoice has been voided.'],
  ] as const)('a waived document (%s) says no credit note will be issued', (reason, text) => {
    renderDialog(reason);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(text);
    expect(screen.getByRole('alertdialog')).not.toHaveAccessibleDescription(/will be issued and emailed/);
  });

  it('the summary names the waiver at once, without a preview read', async () => {
    renderDialog('section_105_receipt');
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    expect(screen.getByTestId('refund-summary-no-credit-note')).toHaveTextContent(
      'No credit note — this payment has a Section 105 receipt, not a tax invoice.',
    );
    expect(screen.queryByTestId('refund-summary-credit-note-loading')).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
