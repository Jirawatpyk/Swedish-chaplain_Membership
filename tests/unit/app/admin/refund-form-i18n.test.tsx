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
import { toast } from 'sonner';
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
  // The `sonner` mock is module-scoped, so its call history leaks between
  // tests — and the f4_bridge_deferred case asserts on exact call counts.
  vi.clearAllMocks();
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

/**
 * Money-remediation Task 7 / I6 — the five route codes that shipped with no
 * `admin.refund.error.*` key in ANY locale.
 *
 * next-intl does not throw on a miss: use-intl 4.11's
 * `defaultGetMessageFallback` returns `joinPath(namespace, key)`, so the
 * try/catch around `tError(code)` in refund-form.tsx is dead code for this
 * class. The admin saw the literal dotted key inside a destructive alert on a
 * money surface. `check:i18n`'s route-code gate now blocks the class; these
 * render-level tests pin the two consequences that a key-existence check
 * cannot see.
 */
async function submitPartialRefund(): Promise<void> {
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
}

describe('RefundForm — I6: previously keyless route codes', () => {
  // Every code below is reachable from THIS dialog and had no key before the
  // Task 7 remediation. `rate_limited` (429) and `invalid_input` (400) are
  // ordinary, not exotic — a stale amount and a post-board-meeting batch.
  const cases = [
    { code: 'tenant_settings_incomplete', status: 422, expect: 'Payment settings are incomplete' },
    { code: 'invalid_input', status: 400, expect: 'rejected as invalid' },
    { code: 'rate_limited', status: 429, expect: 'Too many refund attempts' },
    { code: 'refund_needs_reconciliation', status: 409, expect: 'reconciled manually' },
  ] as const;

  for (const c of cases) {
    it(`renders a localised message for ${c.code}, never the raw key`, async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: c.status,
        json: async () => ({ error: { code: c.code } }),
      })) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      try {
        renderForm();
        await submitPartialRefund();

        const errorBox = await screen.findByTestId('refund-form-error');
        expect(errorBox.textContent).toContain(c.expect);
        // The exact defect: next-intl returning the dotted key as the message.
        expect(errorBox.textContent).not.toContain('admin.refund.error');
        expect(errorBox.textContent).not.toContain(c.code);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

describe('RefundForm — I6: f4_bridge_deferred is a settled refund, not a failure', () => {
  it('closes the dialog with a success toast and offers no retry affordance', async () => {
    // F-3. Stripe SETTLED this refund; only the credit note is outstanding and
    // the stale-pending sweep retries it automatically. The generic !res.ok
    // branch renders every response inside a destructive InlineAlert titled
    // "Couldn't issue the refund" — false here, and precisely the read that
    // made an admin click again and double-refund the member. Adding the i18n
    // key alone is necessary but NOT sufficient: the destructive title is what
    // the eye reads first, so the retry affordance has to disappear entirely.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: { code: 'f4_bridge_deferred' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    try {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <AlertDialog open onOpenChange={() => undefined}>
            <RefundForm
              paymentId="pay_1"
              memberCompanyName="Acme AB"
              remainingRefundableSatang={535000n}
              currencyCode="THB"
              onClose={onClose}
            />
          </AlertDialog>
        </NextIntlClientProvider>,
      );
      await submitPartialRefund();

      // Terminal SUCCESS, exactly like the 202 pending path.
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
      // No destructive alert => no Confirm button to click a second time.
      expect(screen.queryByTestId('refund-form-error')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
