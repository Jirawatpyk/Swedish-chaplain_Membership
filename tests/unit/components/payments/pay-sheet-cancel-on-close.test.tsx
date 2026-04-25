/**
 * Unit tests for PaySheet's W2 stale-PaymentIntent cleanup (FR-025c),
 * revised after audit 2026-04-25 "4-5 open-close ชน limit".
 *
 * Contract (revised):
 *   - Plain drawer close (X / Esc / backdrop) → DOES NOT cancel the
 *     PaymentIntent. Cache persists so a reopen reuses the existing PI
 *     (prevents rate-limit burn on open-close flicker).
 *   - Explicit cancel (ProcessingPanel / 3DS "Cancel payment" buttons,
 *     HardCapPrompt 60-second timeout) → fires POST /cancel + clears
 *     cache + closes drawer.
 *   - Component unmount (page navigate-away) → fires POST /cancel as a
 *     backstop. Stripe's 1-hour PI auto-expiry is the final safety net.
 *   - Payment settled (success / failure) → parent clears cache; no
 *     cancel fires on subsequent close.
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
  const passthrough = (tag: keyof HTMLElementTagNameMap) => {
    const Passthrough = (props: Record<string, unknown>) => {
      const { side: _s, showCloseButton: _c, ...rest } = props as Record<
        string,
        unknown
      >;
      void _s;
      void _c;
      return React.createElement(tag, rest as Record<string, unknown>);
    };
    Passthrough.displayName = `MockPassthrough(${tag})`;
    return Passthrough;
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
        cardAriaLabel: 'Card — switch payment method',
        promptpayAriaLabel: 'PromptPay — switch payment method',
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
describe('<PaySheet> W2 stale-PI cleanup (FR-025c — audit 2026-04-25)', () => {
  // vitest's `MockInstance` for the concrete fetch overload set is
  // structurally incompatible with `ReturnType<typeof vi.spyOn>` (which
  // collapses to a generic `MockInstance<(this: unknown, ...args:
  // unknown[]) => unknown>`). The Node test runtime DOM-shim makes
  // `globalThis.fetch` callable but TS sees the global's keys as the
  // narrow Web-Worker scope where `fetch` isn't directly indexed by
  // `vi.spyOn`'s key constraint. Use the `.mock.calls`-accessing slice
  // we actually need + cast the full spy.
  let fetchSpy: {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };

  beforeEach(() => {
    searchParamsMock.current = new URLSearchParams();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetchSpy;
  });
  afterEach(() => {
    cleanup();
    fetchSpy.mockRestore();
  });

  it('does NOT fire cancel on plain drawer close (rate-limit friendly — cache persists for reopen)', async () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    // User dismisses via Escape — should NOT fire cancel per the
    // revised FR-025c contract (audit 2026-04-25). Previous behaviour
    // fired /cancel on every close and burned the rate-limit budget
    // after ~5 open-close cycles.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires POST /api/payments/{id}/cancel on component unmount (page navigate-away backstop)', async () => {
    const { unmount } = renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    // True unmount = member navigated away. Cleanup must fire cancel.
    unmount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/payments/pmt_test_001/cancel');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(String(init.body));
    expect(body.reason).toBe('user_navigated_away');
  });

  it('does NOT fire cancel on unmount when payment has already settled', async () => {
    const { unmount } = renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-settled'));
    });
    unmount();
    // R5 round-7: settled-effect now fires a fire-and-forget POST to
    // /api/payments/log-optimistic-flip for ops telemetry (M3). Filter
    // it out — the W2 invariant under test is specifically that
    // /cancel was NOT called.
    const cancelCalls = fetchSpy.mock.calls.filter((args) => {
      const url = String(args[0] ?? '');
      return url.includes('/cancel');
    });
    expect(cancelCalls.length).toBe(0);
  });

  it('does NOT fire cancel on unmount when no PaymentIntent was ever created', async () => {
    const { unmount } = renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    // User opens + immediately navigates away WITHOUT the initiate
    // completing → cache is null → no cancel needed.
    unmount();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves cache across open-close cycles (reopens DO NOT re-initiate — rate-limit invariant)', async () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    act(() => {
      fireEvent.click(screen.getByTestId('stub-fire-initiate'));
    });
    // Simulate several open-close cycles. None should fire /cancel.
    for (let i = 0; i < 4; i++) {
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      fireEvent.click(screen.getByTestId('trigger'));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
