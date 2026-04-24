/**
 * Unit tests for PaySheet's W2 stale-PaymentIntent cleanup on close
 * (commit e038afa). FR-025c: closing the drawer WITHOUT settling the
 * payment MUST fire POST /api/payments/{id}/cancel so the stale
 * PaymentIntent does not linger until Stripe's ~1 h auto-expiry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// ---- Mocks ----------------------------------------------------------------
const searchParamsMock = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Inline Sheet — same pattern as pay-sheet.test.tsx so open/close are
// synchronous + we can query everything via screen.*.
vi.mock('@/components/ui/sheet', async () => {
  const React = await import('react');
  const Sheet = ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
    children?: React.ReactNode;
  }) => {
    React.useEffect(() => {
      if (!open) return undefined;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onOpenChange?.(false);
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [open, onOpenChange]);
    return open
      ? React.createElement('div', { 'data-testid': 'sheet-root' }, children)
      : null;
  };
  const passthrough = (tag: keyof HTMLElementTagNameMap) =>
    (props: Record<string, unknown>) => {
      const { side: _s, showCloseButton: _c, ...rest } = props as Record<
        string,
        unknown
      >;
      void _s;
      void _c;
      return React.createElement(tag, rest as Record<string, unknown>);
    };
  return {
    Sheet,
    SheetContent: passthrough('div'),
    SheetHeader: passthrough('div'),
    SheetTitle: passthrough('h2'),
    SheetDescription: passthrough('p'),
    SheetFooter: passthrough('div'),
    SheetTrigger: passthrough('button'),
    SheetClose: passthrough('button'),
  };
});

// Replace next/dynamic with a REAL component that exposes the
// onInitiateResolved + onPaymentSettled callbacks via two test
// buttons. That lets the test simulate "initiate succeeded" and
// "payment reached terminal" independently of a real Stripe flow.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  interface InternalProps {
    readonly onInitiateResolved?: (r: {
      clientSecret: string;
      publishableKey: string;
      paymentIntentId: string;
      paymentDbId: string;
    }) => void;
    readonly onPaymentSettled?: () => void;
  }
  function PaySheetInternalStub(props: InternalProps) {
    return React.createElement(
      'div',
      { 'data-testid': 'pay-sheet-internal-stub' },
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'stub-fire-initiate',
          onClick: () =>
            props.onInitiateResolved?.({
              clientSecret: 'pi_test_secret',
              publishableKey: 'pk_test_fake',
              paymentIntentId: 'pi_test_001',
              paymentDbId: 'pmt_test_001',
            }),
        },
        'fire-initiate',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'stub-fire-settled',
          onClick: () => props.onPaymentSettled?.(),
        },
        'fire-settled',
      ),
    );
  }
  return {
    default: () => PaySheetInternalStub,
  };
});

import { PaySheet } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet';

// ---- Fixtures -------------------------------------------------------------
const messages = {
  portal: {
    payment: {
      drawer: {
        title: 'Pay invoice',
        subtitle: '{invoiceNumber}',
        close: 'Close payment drawer',
      },
      methods: {
        card: 'Card',
        promptpay: 'PromptPay',
        cardAriaLabel: 'Switch to card',
        promptpayAriaLabel: 'Switch to PromptPay',
        cardPlaceholder: '',
        promptpayPlaceholder: '',
      },
      skeleton: { loading: 'Loading' },
      hardCap: {
        title: 'Are you still here?',
        body: 'body',
        continue: 'Continue',
        autoCancelCountdown: 'Cancel in {seconds}',
      },
    },
  },
} as const;

const invoice = {
  id: 'inv_1',
  invoiceNumber: 'TSCC-2026-0001',
  amountDue: 535_000,
  currency: 'THB',
} as const;

function renderPaySheet() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PaySheet
        invoice={invoice}
        enabledMethods={['card']}
        tenantPublishableKey="pk_test_fake"
      >
        {(open) => (
          <button type="button" onClick={open} data-testid="trigger">
            Pay
          </button>
        )}
      </PaySheet>
    </NextIntlClientProvider>,
  );
}

// ---- Tests ----------------------------------------------------------------
describe('<PaySheet> W2 stale-PI cleanup on explicit close (FR-025c)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    searchParamsMock.current = new URLSearchParams();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => {
    cleanup();
    fetchSpy.mockRestore();
  });

  it('fires POST /api/payments/{id}/cancel when drawer closes WITHOUT settlement', async () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    // Simulate initiate resolving — cache populates with paymentDbId.
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    // User dismisses via Escape.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/payments/pmt_test_001/cancel');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(String(init.body));
    expect(body.reason).toBe('user_closed_drawer');
  });

  it('does NOT fire cancel when payment has already settled (success/failure)', async () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    // Simulate payment terminal (success or failure).
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-settled'));
    });
    // User closes — settled = skip cancel.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire cancel when drawer closes BEFORE initiate resolves (no cached PI)', async () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    // User changes mind immediately — no initiate click.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-fires cancel for a NEW PaymentIntent on a re-open after settle+close', async () => {
    renderPaySheet();
    // Open #1 — settle + close. No cancel (settled path).
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-settled'));
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Open #2 — new initiate resolves with a FRESH paymentDbId.
    // Because the earlier `onPaymentSettled` cleared the cache AND set
    // paymentSettled=true, the next initiate must reset the settled
    // flag so the close-cleanup path runs for the NEW PI.
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('/api/payments/pmt_test_001/cancel');
  });
});
