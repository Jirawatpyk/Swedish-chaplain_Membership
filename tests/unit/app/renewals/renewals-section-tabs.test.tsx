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

/**
 * Item ④ (plan-wide decision) — count badges on Pending review / Tasks /
 * Tier upgrades tabs, so an admin sees pending work at a glance without
 * opening each tab. Pipeline is deliberately excluded (default view, not a
 * work queue).
 *
 * `renderTabsWithCount` takes an OPTIONS OBJECT (not three positional args)
 * and omits absent keys entirely rather than assigning `undefined` — this
 * repo's `exactOptionalPropertyTypes: true` rejects `{ pendingReviewCount:
 * undefined }` against a `pendingReviewCount?: number` prop (verified via a
 * standalone tsc repro before writing these tests), so the "undefined"
 * case below calls `renderTabsWithCount({})` rather than passing the key
 * with an explicit `undefined` value.
 */
function renderTabsWithCount(
  counts: {
    readonly pendingReviewCount?: number;
    readonly tasksCount?: number;
    readonly tierUpgradeCount?: number;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsSectionTabs showPipelineHelp {...counts} />
    </NextIntlClientProvider>,
  );
}

describe('<RenewalsSectionTabs> pending-review count badge (item ④)', () => {
  it('renders the count badge on the Pending review tab when count > 0', () => {
    renderTabsWithCount({ pendingReviewCount: 4 });
    const pendingTab = screen.getByRole('tab', { name: /pending review/i });
    expect(pendingTab.textContent).toContain('4');
    expect(screen.getByText(/4 cycles awaiting review/i)).toBeInTheDocument();
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ pendingReviewCount: 0 });
    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> tasks count badge (item ④ plan-wide decision)', () => {
  it('renders the count badge on the Tasks tab when count > 0', () => {
    renderTabsWithCount({ tasksCount: 7 });
    const tasksTab = screen.getByRole('tab', { name: /tasks/i });
    expect(tasksTab.textContent).toContain('7');
    expect(screen.getByText(/7 open tasks/i)).toBeInTheDocument();
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ tasksCount: 0 });
    expect(screen.queryByText(/open tasks?/i)).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(screen.queryByText(/open tasks?/i)).not.toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> tier-upgrade count badge (item ④ plan-wide decision)', () => {
  it('renders the count badge on the Tier upgrades tab when count > 0', () => {
    renderTabsWithCount({ tierUpgradeCount: 2 });
    const tierTab = screen.getByRole('tab', { name: /tier upgrades/i });
    expect(tierTab.textContent).toContain('2');
    expect(
      screen.getByText(/2 tier-upgrade suggestions/i),
    ).toBeInTheDocument();
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ tierUpgradeCount: 0 });
    expect(
      screen.queryByText(/tier-upgrade suggestion/i),
    ).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(
      screen.queryByText(/tier-upgrade suggestion/i),
    ).not.toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> Pipeline tab is never badged', () => {
  it('Pipeline tab shows no count badge even when the other three counts are set', () => {
    renderTabsWithCount({
      pendingReviewCount: 4,
      tasksCount: 7,
      tierUpgradeCount: 2,
    });
    const pipelineTab = screen.getByRole('tab', { name: /^pipeline$/i });
    expect(pipelineTab.textContent).toBe('Pipeline');
  });
});

/**
 * Enhancement C1 (#10b) — MANUAL tab activation.
 *
 * Each tab NAVIGATES (`router.push`) on activation, so arrow-key focus must
 * NOT activate — otherwise arrowing across the strip fires a route push per
 * keypress (accidental navigation + push storm). Base UI's `Tabs.List` gates
 * this on `activateOnFocus`; the strip sets `activateOnFocus={false}` so arrow
 * keys MOVE focus (roving tabindex) while Enter / Space / click ACTIVATE.
 *
 * The load-bearing gate is `fireEvent.focus` on a NON-active tab: Base UI's
 * per-tab `onFocus` handler only calls `onTabActivation` when `activateOnFocus`
 * is true, so flipping the prop back to `true` makes the first assertion fail.
 */
describe('<RenewalsSectionTabs> C1 — manual activation (arrow moves focus, does not navigate)', () => {
  it('focusing a non-active tab (arrow-key move) does NOT navigate', () => {
    renderTabs(); // pipeline route → Pipeline active
    nav.push.mockClear();
    const pendingTab = screen.getByRole('tab', { name: /pending review/i });
    fireEvent.focus(pendingTab);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('activating a focused tab by click DOES navigate', () => {
    renderTabs();
    const pendingTab = screen.getByRole('tab', { name: /pending review/i });
    // Contrast with the focus-only case above: focus alone never navigates,
    // but an explicit activation (click; Enter/Space route through the same
    // Base UI onClick) does.
    fireEvent.focus(pendingTab);
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(pendingTab);
    expect(nav.push).toHaveBeenCalledWith('/admin/renewals?view=pending-review');
  });
});

/**
 * Enhancement C2 (#4) — mobile horizontal scroll + touch targets.
 *
 * The four `whitespace-nowrap` triggers overflow a narrow viewport; the strip
 * must scroll inside its OWN `overflow-x-auto` container (never the page body),
 * keeping the help Popover trigger visible beside it. Touch targets are raised
 * to >=44px on coarse pointers (WCAG 2.5.5 / audit goal) while the compact
 * desktop (fine-pointer) height is left unchanged.
 */
describe('<RenewalsSectionTabs> C2 — mobile overflow + touch targets', () => {
  it('wraps the tablist in a horizontal-scroll container (strip scrolls, not the page)', () => {
    renderTabs();
    const tablist = screen.getByRole('tablist');
    expect(tablist.closest('.overflow-x-auto')).not.toBeNull();
  });

  it('the help Popover trigger stays beside the scroll container, not inside it', () => {
    renderTabs(true);
    const helpTrigger = screen.getByRole('button', {
      name: 'About the renewal pipeline',
    });
    // The scroll container clips the tablist only; the help button must live
    // OUTSIDE it so it can never be scrolled out of reach.
    expect(helpTrigger.closest('.overflow-x-auto')).toBeNull();
  });

  it('raises each tab tap target to >=44px on coarse pointers', () => {
    renderTabs();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) {
      expect(tab.className).toContain('pointer-coarse:min-h-11');
    }
  });
});
