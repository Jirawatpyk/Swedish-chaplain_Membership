/**
 * Nav-orphans follow-up — `<RenewalsSectionTabs>` unit tests.
 *
 * Pins the active-state derivation (pathname + `?view=` → which of the 4
 * tabs is selected) and the navigation behaviour for each tab, across all
 * three pages it's rendered on (`/admin/renewals`, `/admin/renewals/tasks`,
 * `/admin/renewals/tier-upgrades`). Renders against real `en.json` (not a
 * stub translator) so a missing/renamed i18n key fails this suite instead
 * of silently rendering the raw key at runtime — see memory note
 * "Real en.json render test".
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RenewalsSectionTabs } from '@/app/(staff)/admin/renewals/_components/renewals-section-tabs';
import en from '@/i18n/messages/en.json';

// Mutable navigation state so each test can simulate a different page's
// pathname + searchParams without re-mocking the module (mirrors the
// `nav` pattern in tests/unit/members/presentation/directory-filters-search-focus.test.tsx).
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: '/admin/renewals',
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

function renderTabs(showPipelineHelp = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsSectionTabs showPipelineHelp={showPipelineHelp} />
    </NextIntlClientProvider>,
  );
}

function activeTabText(container: HTMLElement): string | null {
  const active = container.querySelector('[aria-selected="true"]');
  return active ? active.textContent : null;
}

beforeEach(() => {
  nav.push.mockClear();
  nav.pathname = '/admin/renewals';
  nav.searchParams = new URLSearchParams();
});

describe('<RenewalsSectionTabs> active-state derivation', () => {
  it('/admin/renewals with no view param → Pipeline is active', () => {
    const { container } = renderTabs();
    expect(activeTabText(container)).toBe('Pipeline');
  });

  it('/admin/renewals?view=pending-review → Pending review is active', () => {
    nav.searchParams = new URLSearchParams('view=pending-review');
    const { container } = renderTabs();
    expect(activeTabText(container)).toBe('Pending review');
  });

  it('pathname starting /admin/renewals/tasks → Tasks is active regardless of that page\'s own params', () => {
    nav.pathname = '/admin/renewals/tasks';
    nav.searchParams = new URLSearchParams('status=open&assignment=mine');
    const { container } = renderTabs();
    expect(activeTabText(container)).toBe('Tasks');
  });

  it('pathname starting /admin/renewals/tier-upgrades → Tier upgrades is active', () => {
    nav.pathname = '/admin/renewals/tier-upgrades';
    const { container } = renderTabs();
    expect(activeTabText(container)).toBe('Tier upgrades');
  });

  it('exactly one tab is marked active', () => {
    const { container } = renderTabs();
    expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });
});

describe('<RenewalsSectionTabs> tablist a11y label', () => {
  it('names the whole strip, not just the Pending-review tab', () => {
    renderTabs();
    expect(
      screen.getByRole('tablist', { name: 'Renewals sections' }),
    ).toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> navigation — Tasks / Tier upgrades (plain route push)', () => {
  it('clicking Tasks pushes /admin/renewals/tasks', () => {
    renderTabs();
    fireEvent.click(screen.getByText('Tasks'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/admin/renewals/tasks');
  });

  it('clicking Tier upgrades pushes /admin/renewals/tier-upgrades', () => {
    renderTabs();
    fireEvent.click(screen.getByText('Tier upgrades'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/admin/renewals/tier-upgrades');
  });
});

describe('<RenewalsSectionTabs> navigation — Pipeline / Pending review from the pipeline route', () => {
  it('switching to Pending review drops tier + urgency + cursor (pending-review has no such filters)', () => {
    nav.searchParams = new URLSearchParams('tier=premium&urgency=t-30&cursor=abc');
    renderTabs();
    fireEvent.click(screen.getByText('Pending review'));
    const url = nav.push.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('tier=');
    expect(url).not.toContain('urgency=');
    expect(url).not.toContain('cursor=');
    expect(url).toContain('view=pending-review');
  });

  it('switching back to Pipeline drops view but keeps tier/urgency', () => {
    nav.searchParams = new URLSearchParams('tier=premium&view=pending-review');
    renderTabs();
    fireEvent.click(screen.getByText('Pipeline'));
    const url = nav.push.mock.calls[0]?.[0] as string;
    expect(url).toContain('tier=premium');
    expect(url).not.toContain('view=');
  });
});

describe('<RenewalsSectionTabs> navigation — arriving FROM Tasks/Tier-upgrades', () => {
  it('Pipeline from the Tasks page ignores that page\'s own params (clean URL)', () => {
    nav.pathname = '/admin/renewals/tasks';
    nav.searchParams = new URLSearchParams('status=open&assignment=mine');
    renderTabs();
    fireEvent.click(screen.getByText('Pipeline'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/admin/renewals');
  });

  it('Pending review from the Tier-upgrades page lands on a clean pending-review URL', () => {
    nav.pathname = '/admin/renewals/tier-upgrades';
    nav.searchParams = new URLSearchParams();
    renderTabs();
    fireEvent.click(screen.getByText('Pending review'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/admin/renewals?view=pending-review');
  });
});

describe('<RenewalsSectionTabs> pipeline-help popover visibility', () => {
  it('does not render the help trigger by default (Tasks/Tier-upgrades pages)', () => {
    renderTabs(false);
    expect(
      screen.queryByRole('button', { name: 'About the renewal pipeline' }),
    ).not.toBeInTheDocument();
  });

  it('renders the help trigger when showPipelineHelp is set (Renewals page)', () => {
    renderTabs(true);
    expect(
      screen.getByRole('button', { name: 'About the renewal pipeline' }),
    ).toBeInTheDocument();
  });
});
