/**
 * Spec 122 US8b follow-up — boards `Admin-refund-full` / `Admin-refund-partial`:
 * the dialog names the payment being refunded on one line,
 * "SC-… · Receipt RC-… · {paid amount}, {paid date}".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import { RefundDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('refund=1'),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ creditNote: { kind: 'blocked' } }))));
});

function renderDialog(opts: { receipt: string | null; locale?: 'en' | 'th' }) {
  const locale = opts.locale ?? 'en';
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? thMessages : enMessages}>
      <RefundDialog
        paymentId="pmt_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={3_852_000n}
        currencyCode="THB"
        invoiceSubject="membership"
        invoiceHeadroomSatang={3_852_000n}
        invoiceDocumentNumber="SC-2026-000088"
        receiptDocumentNumberRaw={opts.receipt}
        paidAmountSatang={3_852_000n}
        // 2026-02-01 10:00 Bangkok.
        paidAt="2026-02-01T03:00:00.000Z"
      />
    </NextIntlClientProvider>,
  );
}

describe('RefundDialog — payment line', () => {
  it('one line: invoice · receipt · paid amount, paid date', () => {
    renderDialog({ receipt: 'RC-2026-000088' });
    expect(screen.getByTestId('refund-dialog-payment')).toHaveTextContent(
      /^SC-2026-000088 · Receipt RC-2026-000088 · 38,520\.00 THB, 1 Feb 2026$/,
    );
    // The two-line Invoice no. / Receipt no. list is gone.
    expect(screen.queryByText('Invoice no.')).toBeNull();
    expect(screen.queryByText('Receipt no.')).toBeNull();
  });

  it('a combined document names the invoice number as the receipt, marked combined', () => {
    renderDialog({ receipt: null });
    expect(screen.getByTestId('refund-dialog-payment')).toHaveTextContent(
      /^SC-2026-000088 · Receipt SC-2026-000088 \(combined\) · 38,520\.00 THB, 1 Feb 2026$/,
    );
  });

  it('Thai shows the Buddhist-Era date', () => {
    renderDialog({ receipt: 'RC-2026-000088', locale: 'th' });
    expect(screen.getByTestId('refund-dialog-payment')).toHaveTextContent(/2569$/);
  });
});
