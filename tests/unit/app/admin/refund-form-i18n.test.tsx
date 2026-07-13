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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('Round-2 (#36): a refund_exceeds_remaining server error renders the localised balance message, not the raw key', async () => {
    // The refundable balance shrank between page load and submit (a concurrent
    // refund settled) → /api/refunds/initiate returns 409 code
    // `refund_exceeds_remaining`, whose message needs a {remaining} ICU arg.
    // Pre-fix the server-error path called tError(code) with NO param, so
    // next-intl surfaced the raw key. The fix supplies {remaining}.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'refund_exceeds_remaining' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // Valid PARTIAL refund (< 5,350.00 remaining) so Confirm enables without
      // the full-refund typed-phrase gate.
      fireEvent.change(screen.getByTestId('refund-form-amount'), {
        target: { value: '100' },
      });
      fireEvent.change(screen.getByTestId('refund-form-reason'), {
        target: { value: 'duplicate charge' },
      });
      fireEvent.blur(screen.getByTestId('refund-form-reason'));

      const confirm = screen.getByTestId('refund-form-confirm');
      await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
      fireEvent.click(confirm);

      const errorBox = await screen.findByTestId('refund-form-error');
      // Interpolated, localised message — proves the placeholder resolved.
      expect(errorBox.textContent).toContain(
        'exceeds the remaining refundable balance',
      );
      // Never the raw message key / developer token.
      expect(errorBox.textContent).not.toContain('refund_exceeds_remaining');
      expect(errorBox.textContent).not.toContain('admin.refund.error');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
