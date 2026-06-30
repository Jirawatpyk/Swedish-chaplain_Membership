/**
 * RefundForm validation-message localisation (audit XF-02).
 *
 * Regression guard for the money-form defect where the amount/reason zod
 * codes (amountRequired/amountFormat/reasonRequired/…) leaked verbatim as
 * user-facing text in every locale, and the reason error was computed but
 * never rendered. Renders against the REAL en.json so a missing key would
 * surface as MISSING_MESSAGE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { RefundForm } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// RHF async validation needs real timers (tests/setup.ts installs fake ones).
beforeEach(() => {
  vi.useRealTimers();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AlertDialog open onOpenChange={() => undefined}>
        <RefundForm
          paymentId="pay_1"
          memberCompanyName="Acme AB"
          remainingRefundableSatang={535000n}
          currencyCode="THB"
          onClose={() => undefined}
        />
      </AlertDialog>
    </NextIntlClientProvider>,
  );
}

describe('RefundForm — localised validation messages', () => {
  it('shows a localised amount-format message, never the raw zod code', async () => {
    renderForm();
    const amount = screen.getByTestId('refund-form-amount');
    fireEvent.change(amount, { target: { value: 'abc' } });
    fireEvent.blur(amount);

    expect(
      await screen.findByText(
        'Enter a valid amount — digits with up to 2 decimals.',
      ),
    ).toBeTruthy();
    // The raw developer token must never reach the user.
    expect(screen.queryByText('amountFormat')).toBeNull();
    expect(screen.queryByText('amountRequired')).toBeNull();
  });

  it('renders the reason error inline (it was computed but never shown)', async () => {
    renderForm();
    const reason = screen.getByTestId('refund-form-reason');
    // onChange-mode form: type then clear so validation runs, then blur so the
    // error is allowed to surface (touchedFields gate) → reasonRequired.
    fireEvent.change(reason, { target: { value: 'temp' } });
    fireEvent.change(reason, { target: { value: '' } });
    fireEvent.blur(reason);

    const error = await screen.findByText('Enter a reason for this refund.');
    expect(error).toBeTruthy();
    expect(error.getAttribute('role')).toBe('alert');
    expect(screen.queryByText('reasonRequired')).toBeNull();
  });
});
