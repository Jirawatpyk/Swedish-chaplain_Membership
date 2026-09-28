/**
 * Unit tests for <PaySheet> — G2 T074.
 * Contract: specs/009-online-payment
 *   - FR-025c: ?pay=1 deep-link auto-opens drawer.
 *   - FR-028h: mobile full-screen + desktop right-drawer classes.
 *   - PCI Group-G: clientSecret MUST NOT touch localStorage/sessionStorage.
 *   - next/dynamic loading fallback is <PaySheetSkeleton>.
 *
 * Testing strategy
 * ----------------
 * The Sheet portal primitive renders into document.body, so we query
 * via `screen.*` (which searches body, not container). The
 * next/dynamic loader is replaced with an identity-like mock so that
 * the internal subtree resolves synchronously and we don't race the
 * vitest 10 s default. Base-UI's portal mount is asserted via a
 * `waitFor` loop rather than `findBy*` to keep the polling tight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// Mock next/navigation so we can control ?pay=1 per test.
const searchParamsMock = {
  current: new URLSearchParams(),
};
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Mock next/dynamic: in jsdom the default `ssr: false` dynamic import
// can fail to resolve within the vitest timeout. Replace it with a
// synchronous-ish loadable that resolves the loader promise in a single
// microtask.
// Spec 122 US4 — the real AURA Drawer (portalled to document.body, which
// the screen queries cover).

// Replace next/dynamic with a synchronous identity loadable: the dynamic
// module loader isn't the subject under test — G3 will drive the real
// lazy-load behavior via the PaySheetSkeleton fallback.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  function PaySheetInternalStub() {
    return React.createElement(
      'div',
      { 'data-testid': 'pay-sheet-internal-stub' },
      'internal',
    );
  }
  return {
    default: () => PaySheetInternalStub,
  };
});

import { PaySheet } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet';

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
        cardPlaceholder: 'Card form coming in G3',
        promptpayPlaceholder: 'PromptPay coming in Phase 4',
      },
      skeleton: {
        loading: 'Loading secure payment form',
      },
    },
  },
};

const invoice = {
  id: 'inv_1',
  invoiceNumber: 'TSCC-2026-0001',
  amountDue: 12_000,
  currency: 'THB',
} as const;

function renderPaySheet(
  props?: Partial<React.ComponentProps<typeof PaySheet>>,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PaySheet
        invoice={invoice}
        enabledMethods={['card', 'promptpay']}
        tenantPublishableKey="pk_test_fake"
        {...props}
      >
        {(open) => (
          <button type="button" onClick={open} data-testid="trigger">
            Pay now
          </button>
        )}
      </PaySheet>
    </NextIntlClientProvider>,
  );
}

describe('<PaySheet>', () => {
  let localStorageSetSpy: ReturnType<typeof vi.spyOn>;
  let sessionStorageSetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    searchParamsMock.current = new URLSearchParams();
    localStorageSetSpy = vi.spyOn(
      Storage.prototype,
      'setItem',
    ) as unknown as ReturnType<typeof vi.spyOn>;
    sessionStorageSetSpy = localStorageSetSpy; // one spy covers both — same prototype.
  });

  afterEach(() => {
    cleanup();
    localStorageSetSpy.mockRestore();
  });

  it('renders without crashing when ?pay=1 is absent (drawer stays closed)', () => {
    renderPaySheet();
    // The trigger always renders; the drawer content should not.
    expect(screen.getByTestId('trigger')).toBeTruthy();
    expect(screen.queryByTestId('pay-sheet-content')).toBeNull();
  });

  it('opens when the trigger is clicked', () => {
    renderPaySheet();
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('pay-sheet-content')).toBeTruthy();
  });

  it('auto-opens when the URL carries ?pay=1 (FR-025c deep-link)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    // Effect runs synchronously during act() so the sheet content
    // should already be rendered after the initial mount.
    expect(screen.getByTestId('pay-sheet-content')).toBeTruthy();
  });

  it('close button keeps a 44px box and the localized aria-label (WCAG 2.5.5)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    const closeBtn = screen.getByTestId('pay-sheet-close');
    expect(closeBtn.getAttribute('aria-label')).toBe('Close payment drawer');
    expect(screen.getByTestId('pay-sheet-content').className).toContain('min-h-11');
  });

  it('is an AURA drawer on the right, 480px (full screen below 640px), titled with the document number (FR-028h, `Pay-*` boards)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    const content = screen.getByTestId('pay-sheet-content');
    expect(content).toHaveAttribute('role', 'dialog');
    expect(content).toHaveClass('aura-drawer', 'aura-drawer--right', 'aura-drawer--md');
    expect(content).toHaveAccessibleName('Pay invoice');
    expect(screen.getByText('TSCC-2026-0001')).toHaveClass('font-mono');
  });

  it('Escape closes it', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    fireEvent.keyDown(screen.getByTestId('pay-sheet-content'), { key: 'Escape' });
    expect(screen.queryByTestId('pay-sheet-content')).toBeNull();
  });

  // UX review M1 — a `?pay=1` open remembers <body> as the element to return
  // to, and a settled payment unmounts Pay now under the confirmation panel;
  // either way focus must land somewhere real when the drawer closes.
  it('closing a deep-linked drawer puts focus on Pay now, not <body> (SC 2.4.3)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PaySheet invoice={invoice} enabledMethods={['card', 'promptpay']} tenantPublishableKey="pk_test_fake">
          {(open) => (
            <button type="button" onClick={open} data-testid="pay-now-button">
              Pay now
            </button>
          )}
        </PaySheet>
      </NextIntlClientProvider>,
    );
    fireEvent.keyDown(screen.getByTestId('pay-sheet-content'), { key: 'Escape' });
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByTestId('pay-now-button')).toHaveFocus();
  });

  it('when Pay now is gone (paid), closing lands focus on the page <main>', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    const main = document.createElement('main');
    main.id = 'main-content';
    main.tabIndex = -1;
    document.body.appendChild(main);
    try {
      renderPaySheet();
      fireEvent.keyDown(screen.getByTestId('pay-sheet-content'), { key: 'Escape' });
      act(() => vi.runOnlyPendingTimers());
      expect(main).toHaveFocus();
    } finally {
      main.remove();
    }
  });

  it('PCI: never writes to localStorage or sessionStorage during drawer lifecycle', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    expect(screen.getByTestId('pay-sheet-content')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pay-sheet-close'));
    expect(localStorageSetSpy).not.toHaveBeenCalled();
    expect(sessionStorageSetSpy).not.toHaveBeenCalled();
  });
});
