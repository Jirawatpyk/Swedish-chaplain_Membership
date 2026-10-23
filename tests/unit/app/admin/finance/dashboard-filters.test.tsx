/**
 * 124 US3 — the dashboard filters write the URL the server parses: each pick
 * replaces the URL with the scroll kept; a plan sets the type to Membership
 * and any other type drops the plan; the current FY carries no param and no
 * chip; Events hides the Plan filter; Clear all resets the four params; the
 * chips follow the values the server parsed.
 *
 * Harness: real AURA FilterBar / FilterSelect (a native <select> sits under
 * each listbox) and the shipped `en.json`; `next/navigation` stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const replace = vi.fn();
const url = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => url.current,
  usePathname: () => '/admin/finance',
}));

import {
  DashboardFilters,
  type DashboardFilterValues,
} from '@/app/(staff)/admin/finance/_components/dashboard-filters';

const F = enMessages.admin.invoiceDashboard.filters;

const DEFAULTS: DashboardFilterValues = { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' };

function renderFilters(values: Partial<DashboardFilterValues> = {}, showOrigin = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DashboardFilters
        values={{ ...DEFAULTS, ...values }}
        currentFiscalYear={2026}
        fiscalYears={[
          { value: 2026, label: 'FY 2026 (Jan–Dec)' },
          { value: 2025, label: 'FY 2025 (Jan–Dec)' },
          { value: 2024, label: 'FY 2024 (Jan–Dec)' },
        ]}
        plans={[
          { id: 'regular', label: 'Regular' },
          { id: 'premium', label: 'Premium' },
        ]}
        showOrigin={showOrigin}
      />
    </NextIntlClientProvider>,
  );
}

function selectOf(label: string): HTMLSelectElement {
  const select = screen
    .getByRole('combobox', { name: new RegExp(label) })
    .closest('.aura-select')
    ?.querySelector('select');
  if (!select) throw new Error(`no native select for ${label}`);
  return select;
}

function lastUrl(): string {
  return replace.mock.lastCall?.[0] as string;
}

beforeEach(() => {
  replace.mockClear();
  url.current = new URLSearchParams();
});

describe('<DashboardFilters> — the URL (US3.1, US3.2)', () => {
  it('a type writes ?type= with the scroll kept', () => {
    renderFilters();
    fireEvent.change(selectOf(F.type), { target: { value: 'event' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/finance?type=event', { scroll: false });
  });

  it('picking a plan sets the type to Membership', () => {
    renderFilters();
    fireEvent.change(selectOf(F.plan), { target: { value: 'premium' } });
    const params = new URL(lastUrl(), 'http://x').searchParams;
    expect(params.get('plan')).toBe('premium');
    expect(params.get('type')).toBe('membership');
  });

  it('choosing Events drops the plan', () => {
    url.current = new URLSearchParams('type=membership&plan=premium');
    renderFilters({ type: 'membership', planId: 'premium' });
    fireEvent.change(selectOf(F.type), { target: { value: 'event' } });
    expect(lastUrl()).toBe('/admin/finance?type=event');
  });

  it('choosing All types drops the plan too (a plan means Membership)', () => {
    url.current = new URLSearchParams('type=membership&plan=premium');
    renderFilters({ type: 'membership', planId: 'premium' });
    fireEvent.change(selectOf(F.type), { target: { value: 'all' } });
    expect(lastUrl()).toBe('/admin/finance');
  });

  it('the current FY clears ?fy=; another FY writes it', () => {
    url.current = new URLSearchParams('fy=2025');
    renderFilters({ fiscalYear: 2025 });
    fireEvent.change(selectOf(F.fiscalYear), { target: { value: '2026' } });
    expect(lastUrl()).toBe('/admin/finance');
    fireEvent.change(selectOf(F.fiscalYear), { target: { value: '2024' } });
    expect(lastUrl()).toBe('/admin/finance?fy=2024');
  });

  it('with Events the Plan filter is hidden', () => {
    renderFilters({ type: 'event' });
    expect(screen.queryByRole('combobox', { name: new RegExp(F.plan) })).toBeNull();
  });

  it('the Origin filter exists only while auto-invoice is on', () => {
    renderFilters({}, false);
    expect(screen.queryByRole('combobox', { name: new RegExp(F.origin) })).toBeNull();
  });
});

describe('<DashboardFilters> — chips (US3.1)', () => {
  it('the defaults show no chip', () => {
    renderFilters();
    expect(document.querySelector('.aura-filterbar__chips')?.textContent ?? '').toBe('');
  });

  it('each applied filter is a chip naming it, and Clear all resets every param', () => {
    url.current = new URLSearchParams('type=membership&plan=premium&fy=2025&origin=manual&keep=1');
    renderFilters({ type: 'membership', planId: 'premium', fiscalYear: 2025, origin: 'manual' });
    const chips = document.querySelector('.aura-filterbar__chips');
    expect(chips).toHaveTextContent(`${F.type}: ${F.typeMembership}`);
    expect(chips).toHaveTextContent(`${F.plan}: Premium`);
    expect(chips).toHaveTextContent(`${F.fiscalYear}: FY 2025 (Jan–Dec)`);
    expect(chips).toHaveTextContent(`${F.origin}: ${F.originManual}`);
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(lastUrl()).toBe('/admin/finance?keep=1');
  });

  it('an unknown plan id still names itself (it still filters, D-l)', () => {
    url.current = new URLSearchParams('type=membership&plan=retired-plan');
    renderFilters({ type: 'membership', planId: 'retired-plan' });
    expect(document.querySelector('.aura-filterbar__chips')).toHaveTextContent(`${F.plan}: retired-plan`);
  });
});
