/**
 * Unit tests for <CardForm> — G3 T076.
 * Contract: specs/009-online-payment FR-028b + PCI Group-G.
 *
 * Strategy
 * --------
 * Stripe SDK (`@stripe/stripe-js`) + `@stripe/react-stripe-js` are
 * mocked via vi.mock(). The `<Elements>` stub forwards children inline
 * so the inner <CardFormInner> renders synchronously. The
 * `<PaymentElement>` stub exposes handles to trigger `onReady` and
 * `onLoadError` from inside the test.
 *
 * useStripe / useElements return minimal stubs with spyable
 * `confirmPayment` so we can drive the success / requires_action /
 * failure branches deterministically.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// -- Stripe SDK mocks -------------------------------------------------------
const loadStripeMock = vi.fn();
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: (...args: unknown[]) => loadStripeMock(...args),
}));

// Mutable handles the tests reach into to simulate Stripe behaviour.
const confirmPaymentMock = vi.fn();
const readyHandles: Array<() => void> = [];
const loadErrorHandles: Array<(e: { error?: { message: string } }) => void> = [];

vi.mock('@stripe/react-stripe-js', async () => {
  const React = await import('react');
  return {
    Elements: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        'div',
        { 'data-testid': 'elements-stub' },
        children,
      ),
    PaymentElement: ({
      onReady,
      onLoadError,
    }: {
      onReady?: () => void;
      onLoadError?: (e: { error?: { message: string } }) => void;
    }) => {
      if (onReady) readyHandles.push(onReady);
      if (onLoadError) loadErrorHandles.push(onLoadError);
      return React.createElement(
        'div',
        { 'data-testid': 'payment-element-stub' },
        'PE',
      );
    },
    useStripe: () => ({ confirmPayment: confirmPaymentMock }),
    useElements: () => ({}),
  };
});

// next-themes mock — avoid ThemeProvider requirement.
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

import { CardForm } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/card-form';

const messages = {
  portal: {
    payment: {
      payNow: 'Pay now',
      payAmount: 'Pay {amount}',
      processing: { title: 'Processing…' },
      skeleton: {
        loading: 'Loading secure payment form',
      },
      retry: {
        title: 'Payment failed',
        body: '{reason} Please try again.',
        cta: 'Try again',
        alternativeMethod: 'Use another method',
        genericReason: 'Payment could not be completed.',
        reason3dsTimeout: 'Bank verification timed out.',
        reasonRateLimited: 'Too many attempts.',
        reasonRateLimitedWithSeconds: 'Too many attempts. Wait {seconds} s.',
        reasonAuth: 'Your session expired.',
        reasonServer: 'Payment service unavailable.',
        reasonNetwork: 'Network error.',
        reasonCardDeclined: 'Your card was declined.',
        reasonIncorrectCvc: 'Your card’s security code is incorrect.',
        reasonExpiredCard: 'Your card has expired.',
        reasonInsufficientFunds: 'Your card has insufficient funds.',
        reasonProcessingError: 'Processing error.',
      },
      error: {
        elementLoadFailed: 'We couldn’t load the payment form.',
      },
    },
  },
};

function renderCardForm(
  overrides: Partial<React.ComponentProps<typeof CardForm>> = {},
) {
  const props: React.ComponentProps<typeof CardForm> = {
    clientSecret: 'pi_test_secret_123',
    publishableKey: 'pk_test_fake',
    amountDue: 12_000,
    currency: 'THB',
    invoiceId: 'inv_1',
    memberId: 'mem_1',
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    onRequiresAction: vi.fn(),
    ...overrides,
  };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CardForm {...props} />
    </NextIntlClientProvider>,
  );
  return props;
}

describe('<CardForm>', () => {
  let localStorageSetSpy: ReturnType<typeof vi.spyOn>;
  let sessionStorageSetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    confirmPaymentMock.mockReset();
    readyHandles.length = 0;
    loadErrorHandles.length = 0;
    loadStripeMock.mockReset();
    loadStripeMock.mockResolvedValue({});
    localStorageSetSpy = vi.spyOn(Storage.prototype, 'setItem');
    sessionStorageSetSpy = localStorageSetSpy;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorageSetSpy.mockRestore();
  });

  it('mounts with form hidden (opacity-0 + aria-hidden) while Stripe paints; skeleton is OWNED by <PaySheetInternal>, not CardForm (T082 2026-04-24)', () => {
    // T082 UX feedback 2026-04-24: previous architecture rendered
    // skeleton in BOTH CardForm AND PaySheetInternal → stacked
    // loading indicators. Fix: parent owns the single skeleton;
    // CardForm starts hidden (opacity-0 + aria-hidden) so Stripe
    // paints its iframe off-screen without flashing underneath.
    renderCardForm();
    // PaymentElement stub IS mounted so Stripe can fire onReady…
    expect(screen.getByTestId('payment-element-stub')).toBeTruthy();
    // …but the form wrapper div must start hidden.
    const form = screen.getByTestId('pay-sheet-card-form');
    const hiddenWrapper = form.querySelector('[aria-hidden="true"]');
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper!.className).toMatch(/opacity-0/);
    expect(hiddenWrapper!.className).toMatch(/pointer-events-none/);
    // Contract: NO aria-busy anywhere inside CardForm — that role
    // lives on <PaySheetSkeleton> which is a sibling in PaySheetInternal,
    // never a descendant of the form. Prevents duplicate live-region flooding.
    expect(form.querySelector('[aria-busy="true"]')).toBeNull();
    // And the skeleton testid explicitly MUST NOT appear inside CardForm.
    expect(screen.queryByTestId('pay-sheet-card-skeleton')).toBeNull();
  });

  it('after onReady + 300 ms min delay, PaymentElement becomes visible and skeleton disappears', async () => {
    renderCardForm();
    act(() => {
      for (const fn of readyHandles) fn();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const form = screen.getByTestId('pay-sheet-card-form');
    // Skeleton is fully unmounted — NOT merely toggled sr-only — and
    // no aria-busy region remains inside the form.
    expect(screen.queryByTestId('pay-sheet-card-skeleton')).toBeNull();
    expect(form.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByTestId('pay-sheet-card-submit')).toBeTruthy();
  });

  it('onLoadError swaps in the error card with retry button', () => {
    renderCardForm();
    act(() => {
      for (const fn of loadErrorHandles) {
        fn({ error: { message: 'Stripe Elements failed to load' } });
      }
    });
    expect(screen.getByTestId('pay-sheet-card-load-error')).toBeTruthy();
    expect(screen.getByTestId('pay-sheet-card-load-retry')).toBeTruthy();
  });

  it('submit with requires_action result calls onRequiresAction', async () => {
    const onRequiresAction = vi.fn();
    confirmPaymentMock.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'requires_action' },
    });
    renderCardForm({ onRequiresAction });
    // Ready + min-delay so submit button exists.
    act(() => {
      for (const fn of readyHandles) fn();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      // Drain the microtask queue so the confirmPayment() promise
      // resolves and state transitions under fake timers.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRequiresAction).toHaveBeenCalledWith({ paymentIntentId: 'pi_1' });
  });

  it('submit with succeeded result calls onSuccess', async () => {
    const onSuccess = vi.fn();
    confirmPaymentMock.mockResolvedValue({
      paymentIntent: { id: 'pi_2', status: 'succeeded' },
    });
    renderCardForm({ onSuccess });
    act(() => {
      for (const fn of readyHandles) fn();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSuccess).toHaveBeenCalledWith({
      paymentIntentId: 'pi_2',
      status: 'succeeded',
    });
  });

  it('submit with error result calls onFailure (localized from code)', async () => {
    const onFailure = vi.fn();
    confirmPaymentMock.mockResolvedValue({
      error: { message: 'Card was declined', code: 'card_declined' },
    });
    renderCardForm({ onFailure });
    act(() => {
      for (const fn of readyHandles) fn();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
      await Promise.resolve();
    });
    // `code === 'card_declined'` (no decline_code) → our i18n key
    // `reasonCardDeclined`, NOT Stripe's raw English message.
    expect(onFailure).toHaveBeenCalledWith({
      message: 'Your card was declined.',
      code: 'card_declined',
    });
  });

  // -- decline_code branch (T082 empirical 2026-04-24) ---------------------
  // Stripe returns `code: 'card_declined'` with a specific
  // `decline_code` sub-discriminator (insufficient_funds, expired_card,
  // incorrect_cvc, processing_error, …). The earlier switch only
  // branched on `code` so EVERY decline localized to
  // "Your card was declined." We added a `decline_code` branch FIRST
  // that maps specific reasons before falling through to the generic
  // `card_declined`. This test suite pins that matrix.
  describe('decline_code branch (T082 2026-04-24)', () => {
    type Case = {
      decline_code: string;
      expected: string;
    };
    const cases: readonly Case[] = [
      { decline_code: 'insufficient_funds', expected: 'Your card has insufficient funds.' },
      { decline_code: 'expired_card', expected: 'Your card has expired.' },
      { decline_code: 'incorrect_cvc', expected: 'Your card’s security code is incorrect.' },
      { decline_code: 'processing_error', expected: 'Processing error.' },
    ];

    it.each(cases)(
      'maps decline_code=%o to its specific localized reason',
      async ({ decline_code, expected }) => {
        const onFailure = vi.fn();
        confirmPaymentMock.mockResolvedValue({
          error: {
            message: 'Card was declined',
            code: 'card_declined',
            decline_code,
          },
        });
        renderCardForm({ onFailure });
        act(() => {
          for (const fn of readyHandles) fn();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(350);
        });
        const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
        await act(async () => {
          fireEvent.submit(form);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(onFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: expected, code: 'card_declined' }),
        );
      },
    );

    it('falls back to Stripe English message when code is unknown', async () => {
      const onFailure = vi.fn();
      confirmPaymentMock.mockResolvedValue({
        error: {
          message: 'Some novel Stripe error',
          code: 'totally_unknown_code',
        },
      });
      renderCardForm({ onFailure });
      act(() => {
        for (const fn of readyHandles) fn();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onFailure).toHaveBeenCalledWith({
        message: 'Some novel Stripe error',
        code: 'totally_unknown_code',
      });
    });

    it('falls back to generic i18n when Stripe message is absent + code unknown', async () => {
      const onFailure = vi.fn();
      confirmPaymentMock.mockResolvedValue({
        error: { code: 'totally_unknown_code' },
      });
      renderCardForm({ onFailure });
      act(() => {
        for (const fn of readyHandles) fn();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Payment could not be completed.',
        }),
      );
    });

    it('maps code=authentication_required to reason3dsTimeout (non-decline branch)', async () => {
      const onFailure = vi.fn();
      confirmPaymentMock.mockResolvedValue({
        error: {
          message: 'Authentication required',
          code: 'authentication_required',
        },
      });
      renderCardForm({ onFailure });
      act(() => {
        for (const fn of readyHandles) fn();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Bank verification timed out.',
          code: 'authentication_required',
        }),
      );
    });
  });

  it('PCI: never writes to localStorage or sessionStorage throughout lifecycle', async () => {
    confirmPaymentMock.mockResolvedValue({
      paymentIntent: { id: 'pi_x', status: 'succeeded' },
    });
    renderCardForm();
    act(() => {
      for (const fn of readyHandles) fn();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const form = screen.getByTestId('pay-sheet-card-form') as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Filter for the Stripe-secret-prefix token to be strict.
    const writtenValues = localStorageSetSpy.mock.calls.map((c) => String(c[1]));
    expect(writtenValues.some((v) => v.includes('pi_test_secret_123'))).toBe(
      false,
    );
    expect(sessionStorageSetSpy.mock.calls).toEqual(
      localStorageSetSpy.mock.calls,
    );
  });
});
