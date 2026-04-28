/**
 * T086 — Unit tests for <MemberCommandPalette>.
 *
 * cmdk + Radix Dialog rely on DOM APIs (ResizeObserver, pointer-
 * events layout, focus trap) that are expensive to polyfill in jsdom,
 * so the `@/components/ui/command` primitives are mocked to plain-HTML
 * stand-ins. The test focus is behavioural: role-gating, fetch wiring,
 * and the navigation target (FR-025c `?pay=1`).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Replace the heavy cmdk + Dialog stack with a trivial visibility-gated
// div tree. Behaviour we still exercise: open state, input value →
// `onValueChange`, `onSelect` firing on click.
vi.mock('@/components/ui/command', () => {
  function CommandDialog({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    title: string;
    description: string;
    children: React.ReactNode;
  }) {
    if (!open) return null;
    return <div role="dialog">{children}</div>;
  }
  function Command({ children }: { children: React.ReactNode }) {
    return <div data-testid="cmd-root">{children}</div>;
  }
  function CommandInput({
    placeholder,
    value,
    onValueChange,
  }: {
    placeholder: string;
    value: string;
    onValueChange: (v: string) => void;
  }) {
    return (
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      />
    );
  }
  function CommandList({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  }
  function CommandEmpty({ children }: { children: React.ReactNode }) {
    return <div data-testid="cmd-empty">{children}</div>;
  }
  function CommandGroup({
    heading,
    children,
  }: {
    heading: string;
    children: React.ReactNode;
  }) {
    return (
      <div>
        <div data-testid="cmd-heading">{heading}</div>
        {children}
      </div>
    );
  }
  function CommandItem({
    onSelect,
    children,
  }: {
    onSelect?: () => void;
    value?: string;
    children: React.ReactNode;
  }) {
    return (
      <button type="button" onClick={() => onSelect?.()}>
        {children}
      </button>
    );
  }
  return {
    CommandDialog,
    Command,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
  };
});

import { MemberCommandPalette } from '@/components/command-palette/member-invoices-group';

const messages = {
  palette: {
    title: 'Command palette',
    description: 'Search',
    placeholder: 'Type a command or search…',
  },
  portal: {
    payment: {
      cmdkPay: {
        group: 'Payments',
        title: 'Pay invoice',
        description: 'Search an issued invoice to pay online',
        placeholder: 'Search your invoices…',
        label: 'Pay invoice {invoiceNumber} · {amount}',
        emptyHint: 'No issued invoices to pay',
        allPaidHint: "No pending invoices — you're all paid up ✨",
      },
    },
  },
};

function renderPalette(role: 'member' | 'admin' | 'manager' = 'member') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MemberCommandPalette currentUserRole={role} />
    </NextIntlClientProvider>,
  );
}

function triggerCtrlK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
    );
  });
}

describe('<MemberCommandPalette>', () => {
  beforeEach(() => {
    // The global setup installs fake timers (for TTL tests) which
    // deadlocks React 19's useDeferredValue scheduler. Swap to real
    // timers for this suite — it never inspects Date.
    vi.useRealTimers();
    pushMock.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/portal/invoices/search')) {
          return new Response(
            JSON.stringify({
              invoices: [
                {
                  // F-01 fix: response now carries major-unit THB
                  // (50,000 THB) rather than minor-unit satang.
                  id: 'inv-123',
                  invoiceNumber: 'TSCC-2026-0007',
                  amountDue: 50_000,
                  currency: 'THB',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing for non-member roles (defence-in-depth)', () => {
    renderPalette('admin');
    triggerCtrlK();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on Ctrl+K and renders fetched issued invoices with formatted amount in the label', async () => {
    renderPalette('member');
    triggerCtrlK();

    expect(screen.getByRole('dialog')).toBeTruthy();

    // F-05 fix: the visible label now includes the formatted amount
    // so members can confirm the amount before pressing Enter. The
    // en-US Intl.NumberFormat grouping renders 50,000 as "50,000".
    await waitFor(
      () =>
        expect(
          screen.getByText('Pay invoice TSCC-2026-0007 · THB 50,000'),
        ).toBeTruthy(),
      { timeout: 1500 },
    );
    expect(screen.getByTestId('cmd-heading').textContent).toBe('Payments');
  });

  it('navigates to /portal/invoices/<id>?pay=1 on select (FR-025c)', async () => {
    renderPalette('member');
    triggerCtrlK();

    const item = await screen.findByText(
      'Pay invoice TSCC-2026-0007 · THB 50,000',
      undefined,
      { timeout: 1500 },
    );
    fireEvent.click(item);

    expect(pushMock).toHaveBeenCalledWith('/portal/invoices/inv-123?pay=1');
  });

  it('uses the portal.payment.cmdkPay.placeholder (F-03 namespace fix)', () => {
    renderPalette('member');
    triggerCtrlK();
    expect(screen.getByPlaceholderText('Search your invoices…')).toBeTruthy();
  });

  it('shows the empty-hint when a typed query returns no rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ invoices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    renderPalette('member');
    triggerCtrlK();

    const input = screen.getByPlaceholderText('Search your invoices…');
    fireEvent.change(input, { target: { value: 'TSCC-999' } });

    await waitFor(
      () =>
        expect(screen.getByTestId('cmd-empty').textContent).toBe(
          'No issued invoices to pay',
        ),
      { timeout: 1500 },
    );
  });

  it('shows the allPaid-hint when zero invoices AND no query (F-04 fix)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ invoices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    renderPalette('member');
    triggerCtrlK();

    await waitFor(
      () =>
        expect(screen.getByTestId('cmd-empty').textContent).toBe(
          "No pending invoices — you're all paid up ✨",
        ),
      { timeout: 1500 },
    );
  });
});
