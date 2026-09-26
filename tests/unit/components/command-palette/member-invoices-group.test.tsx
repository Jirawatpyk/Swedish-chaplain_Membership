/**
 * T086 — Unit tests for <MemberCommandPalette>.
 *
 * Rendered on AURA `Command` itself (spec 122 US1) — no stand-in: its dialog,
 * combobox and options are plain DOM that jsdom handles. The test focus is
 * behavioural: role-gating, fetch wiring, and the navigation target
 * (FR-025c `?pay=1`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

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
    broadcasts: {
      cmdk: {
        group: 'Broadcasts',
        compose: { title: 'Compose E-Blast' },
        benefits: { title: 'View E-Blast usage' },
      },
    },
  },
};

function renderPalette(
  role: 'member' | 'admin' | 'manager' = 'member',
  membershipAccess?: 'full' | 'suspended' | 'terminated',
  broadcastsEnabled?: boolean,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MemberCommandPalette
        currentUserRole={role}
        {...(membershipAccess !== undefined ? { membershipAccess } : {})}
        {...(broadcastsEnabled !== undefined ? { broadcastsEnabled } : {})}
      />
    </NextIntlClientProvider>,
  );
}

function triggerCtrlK() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
}

const option = (name: string) => screen.queryByRole('option', { name });

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
    await waitFor(() => expect(option('Pay invoice TSCC-2026-0007 · THB 50,000')).not.toBeNull(), {
      timeout: 1500,
    });
    // Two groups ("Payments" + "Broadcasts" — F7 US3 added the Broadcasts
    // group), Payments first.
    const groups = screen.getAllByRole('group').map((g) => within(g).getAllByRole('presentation')[0]?.textContent);
    expect(groups).toEqual(['Payments', 'Broadcasts']);
  });

  it('navigates to /portal/invoices/<id>?pay=1 on select (FR-025c)', async () => {
    renderPalette('member');
    triggerCtrlK();

    const item = await screen.findByRole(
      'option',
      { name: 'Pay invoice TSCC-2026-0007 · THB 50,000' },
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

    await waitFor(() => expect(screen.getByText('No issued invoices to pay')).toBeInTheDocument(), {
      timeout: 1500,
    });
  });

  it('shows "Compose E-Blast" by default (membershipAccess omitted → full)', () => {
    renderPalette('member');
    triggerCtrlK();
    expect(option('Compose E-Blast')).not.toBeNull();
  });

  it('059-membership-suspension: hides "Compose E-Blast" when suspended (dead-end target)', () => {
    renderPalette('member', 'suspended');
    triggerCtrlK();
    expect(option('Compose E-Blast')).toBeNull();
    // "View E-Blast usage" stays — the Benefits page is open while suspended.
    expect(option('View E-Blast usage')).not.toBeNull();
  });

  it('059-membership-suspension: hides "Compose E-Blast" when terminated', () => {
    renderPalette('member', 'terminated');
    triggerCtrlK();
    expect(option('Compose E-Blast')).toBeNull();
  });

  it('F7 break-glass: hides "Compose E-Blast" when broadcasts are disabled, but keeps "View E-Blast usage"', () => {
    renderPalette('member', 'full', false);
    triggerCtrlK();
    // Compose deep-links to /portal/broadcasts/new, which the proxy 503s when
    // F7 is off — hide the dead-end shortcut.
    expect(option('Compose E-Blast')).toBeNull();
    // "View E-Blast usage" stays — it lands on the Benefits page, which falls
    // back to the benefits tab gracefully under F7-off.
    expect(option('View E-Blast usage')).not.toBeNull();
  });

  it('F7 on + full access: shows "Compose E-Blast" (regression guard for the new prop default)', () => {
    renderPalette('member', 'full', true);
    triggerCtrlK();
    expect(option('Compose E-Blast')).not.toBeNull();
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

    // An inert row at the top of Payments — the E-Blast shortcuts stay below it.
    const row = await screen.findByRole('option', { name: "No pending invoices — you're all paid up ✨" }, { timeout: 1500 });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(option('View E-Blast usage')).not.toBeNull();
  });
});
