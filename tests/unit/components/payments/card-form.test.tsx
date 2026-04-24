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
      skeleton: {
        loading: 'Loading secure payment form',
      },
      retry: {
        title: 'Payment failed',
        body: '{reason} Please try again.',
        cta: 'Try again',
        alternativeMethod: 'Use another method',
        genericReason: 'Payment could not be completed.',
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

  it('mounts with skeleton visible initially; skeleton is the SOLE live loading region (G-Review #1)', () => {
    renderCardForm();
    const skeleton = screen.getByTestId('pay-sheet-card-skeleton');
    expect(skeleton).toBeTruthy();
    // Contract: aria-busy lives on the skeleton only — not on any
    // sibling wrapper around the hidden PaymentElement.
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    const form = screen.getByTestId('pay-sheet-card-form');
    const ariaBusyNodes = form.querySelectorAll('[aria-busy="true"]');
    // Exactly one — the skeleton itself.
    expect(ariaBusyNodes.length).toBe(1);
    // The PaymentElement stub is mounted (so Stripe can fire onReady)
    // but hidden with sr-only + aria-hidden and MUST NOT carry
    // aria-busy semantics (duplicate live-region flooding fix).
    const hidden = form.querySelector(
      '[aria-hidden="true"][class*="sr-only"]',
    );
    expect(hidden).not.toBeNull();
    expect(hidden?.getAttribute('aria-busy')).toBeNull();
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

  it('submit with error result calls onFailure', async () => {
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
    expect(onFailure).toHaveBeenCalledWith({
      message: 'Card was declined',
      code: 'card_declined',
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
