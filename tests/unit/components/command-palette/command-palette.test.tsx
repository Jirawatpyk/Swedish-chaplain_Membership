/**
 * Spec 122 US1 T106 — the staff palette on AURA `Command` keeps its
 * contract: ⌘K and the top bar's search button open it, nothing is fetched
 * before a keystroke, the server's results are listed as sent (grouped, no
 * client filter), and choosing one navigates and closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { openCommandPalette } from '@/components/command-palette/open-event';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

const RESULTS = {
  results: {
    plans: [
      { plan_id: 'p1', plan_year: 2026, plan_name: 'Premium Corporate', category: 'corporate', is_active: true, url: '/admin/plans/2026/p1' },
    ],
    members: [
      {
        member_id: 'm1',
        company_name: 'Siam Nordic Trading',
        primary_contact_name: 'Erik Johansson',
        status: 'active',
        url: '/admin/members/m1',
        member_number_display: 'TSCC-0003',
      },
    ],
    refundableInvoices: [],
    actions: [{ id: 'new-plan', label: 'palette.actions.newPlan', url: '/admin/plans/new', requires: 'admin' }],
    navigate: [],
  },
};

function renderPalette() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CommandPalette />
    </NextIntlClientProvider>,
  );
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESULTS), { status: 200 }));

beforeEach(() => {
  vi.useRealTimers();
  pushMock.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

describe('CommandPalette (staff, spec 122 US1)', () => {
  it('opens on Ctrl+K as the "Command palette" dialog with the input focused, fetching nothing yet', () => {
    renderPalette();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens from the top bar\'s search button', () => {
    renderPalette();
    act(() => openCommandPalette());
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('lists the server\'s results under their groups and navigates to the chosen one', async () => {
    renderPalette();
    act(() => openCommandPalette());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sia' } });

    // Not "Siam…" — the server searched; the palette must not filter again.
    const plan = await screen.findByRole('option', { name: /Premium Corporate/ });
    expect(fetchMock).toHaveBeenCalledWith('/api/plans/search?q=sia', expect.anything());
    const groups = screen.getAllByRole('group').map((g) => within(g).getAllByRole('presentation')[0]?.textContent);
    expect(groups).toEqual(['Plans', 'Members', 'Actions']);
    expect(screen.getByRole('option', { name: /Siam Nordic Trading.*TSCC-0003/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Create new plan' })).toBeInTheDocument();

    fireEvent.click(plan);
    expect(pushMock).toHaveBeenCalledWith('/admin/plans/2026/p1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
