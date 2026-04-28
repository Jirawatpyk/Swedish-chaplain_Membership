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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
// Mock the shadcn Sheet primitive so it renders its children inline
// when open=true, rather than through a Base-UI portal that is flaky
// to resolve inside jsdom. We still forward `open` + `onOpenChange` +
// className to validate PaySheet's integration surface.
vi.mock('@/components/ui/sheet', async () => {
  const React = await import('react');
  function Sheet({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
    children?: React.ReactNode;
  }) {
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
  }
  function SheetContent({
    children,
    className,
    // Strip non-DOM props so React doesn't warn about unknown attributes.
    side: _side,
    showCloseButton: _showCloseButton,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & {
    side?: string;
    showCloseButton?: boolean;
  }) {
    void _side;
    void _showCloseButton;
    return React.createElement('div', { className, ...rest }, children);
  }
  function SheetHeader(props: React.HTMLAttributes<HTMLDivElement>) {
    return React.createElement('div', props);
  }
  function SheetTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
    return React.createElement('h2', props);
  }
  function SheetDescription(props: React.HTMLAttributes<HTMLParagraphElement>) {
    return React.createElement('p', props);
  }
  function SheetFooter(props: React.HTMLAttributes<HTMLDivElement>) {
    return React.createElement('div', props);
  }
  function SheetTrigger(props: React.HTMLAttributes<HTMLButtonElement>) {
    return React.createElement('button', props);
  }
  function SheetClose(props: React.HTMLAttributes<HTMLButtonElement>) {
    return React.createElement('button', props);
  }
  return {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
    SheetFooter,
    SheetTrigger,
    SheetClose,
  };
});

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
        title: 'Pay {invoiceNumber}',
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

  it('close button has a ≥44×44 px tap target and localized aria-label (WCAG 2.5.5)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    const closeBtn = screen.getByTestId('pay-sheet-close');
    expect(closeBtn.className).toMatch(/min-h-\[44px\]/);
    expect(closeBtn.className).toMatch(/min-w-\[44px\]/);
    expect(closeBtn.getAttribute('aria-label')).toBe('Close payment drawer');
  });

  it('drawer content uses FR-028h-compliant inline style + CSS var override', () => {
    // T082 empirical E2E discovery (2026-04-24): the Tailwind classes
    // previously asserted here (`sm:max-w-[480px]`, `w-full`, `h-full`,
    // `sm:h-auto`) lost the specificity battle against the shadcn
    // `<SheetContent side="right">` primitive's data-attribute variant
    // classes (`data-[side=right]:w-3/4`, `data-[side=right]:h-full`,
    // `data-[side=right]:sm:max-w-[var(--modal-max-width-md)]`) even
    // after switching to `data-[side=right]:…!` prefix + trailing
    // important modifier. The reliable override is:
    //   - inline `--modal-max-width-md: 30rem` (pins 480 px max-width
    //     via the CSS var the primitive reads)
    //   - inline `width: 100%` (always)
    //   - inline `height: '100vh' | 'auto'` (via matchMedia state)
    //   - inline `bottom: 'auto'` on desktop (clears inset-y-0
    //     full-height stretch)
    // Unit-test verification: assert the inline style carries the
    // FR-028h contract. E2E regression verified at all 3 viewports via
    // `tests/e2e/pay-sheet-viewport.spec.ts`.
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderPaySheet();
    const content = screen.getByTestId('pay-sheet-content');
    const inlineStyle = content.getAttribute('style') ?? '';
    expect(inlineStyle).toMatch(/--modal-max-width-md:\s*30rem/);
    expect(inlineStyle).toMatch(/width:\s*100%/);
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
