/**
 * Spec 122 US8b (parity comments, 3 Oct; boards `Admin-refund-full`,
 * `-partial`): the refund form's help line, summary box, confirm label and
 * typed-phrase prompt follow the boards. The amounts are display only — the
 * request body and the typed phrase are unchanged (refund-form-i18n,
 * refund-form-membership).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundForm } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  vi.useRealTimers();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RefundForm
        paymentId="pay_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={3_852_000n}
        currencyCode="THB"
        invoiceSubject="event"
        invoiceHeadroomSatang={3_852_000n}
        onClose={() => undefined}
      />
    </NextIntlClientProvider>,
  );
}

describe('RefundForm — board parity', () => {
  it('the help line says how much can go back, once in THB', () => {
    renderForm();
    const help = document.querySelector('[id$="-help"]');
    expect(help).toHaveTextContent('Up to 38,520.00 THB (paid, less refunds and credit notes). It goes back to the original payment method.');
    expect(help?.textContent).not.toContain('THB THB');
  });

  it('a valid amount shows the refund summary and names the amount on the confirm, with the refund icon', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Issue refund' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    const summary = screen.getByTestId('refund-summary');
    expect(within(summary).getByText('Refund total').nextElementSibling).toHaveTextContent('5,350.00 THB');
    expect(within(summary).getByText('Still refundable afterwards').nextElementSibling).toHaveTextContent('33,170.00 THB');
    const confirm = screen.getByTestId('refund-form-confirm');
    expect(confirm).toHaveAccessibleName('Refund 5,350.00 THB');
    expect(confirm.querySelector('svg.aura-icon')).not.toBeNull();
  });

  it('no summary until the amount is valid', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: 'abc' } });
    expect(screen.queryByTestId('refund-summary')).toBeNull();
  });

  it('a full refund shows the phrase to type as its own chip, with a copy button', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '38520' } });
    const chip = screen.getByTestId('refund-typed-phrase-chip');
    expect(chip.tagName).toBe('CODE');
    expect(chip).toHaveTextContent(/^REFUND Acme AB$/);
    expect(screen.getByRole('button', { name: 'Copy REFUND Acme AB' })).toBeInTheDocument();
    // The phrase stays in what a screen reader hears for the input.
    expect(screen.getByTestId('refund-typed-phrase-input')).toHaveAccessibleDescription(/REFUND Acme AB/);
  });

  it('the chip sits between the label and the box (AURA 5.31 labelAddon); the description opens with the phrase', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '38520' } });
    const input = screen.getByTestId('refund-typed-phrase-input');
    const addon = screen.getByTestId('refund-typed-phrase-chip').closest('.aura-field__addon');
    expect(addon).not.toBeNull();
    expect(addon!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input).toHaveAccessibleDescription(/^REFUND Acme AB (?!Copy)/);
  });
});
