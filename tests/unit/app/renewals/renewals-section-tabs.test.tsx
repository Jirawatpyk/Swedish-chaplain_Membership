/**
 * Nav-orphans follow-up — `<RenewalsSectionTabs>` unit tests.
 *
 * Whole-branch review #9 refactored this strip from an ARIA tablist to a
 * `<nav>` landmark of real `<Link>`s (the entries navigate to different
 * routes/URLs, so a tab role — with no `role="tabpanel"` — was wrong). These
 * tests pin the nav contract:
 *   - a `<nav>` with the accessible name spanning all four entries;
 *   - each entry is a link with the CORRECT `href` (Pipeline/Pending-review
 *     inherit the pipeline's params only when ON the pipeline route; Tasks /
 *     Tier-upgrades are plain route hrefs);
 *   - the ACTIVE entry carries `aria-current="page"` and the others do not,
 *     across all three pages it's rendered on (`/admin/renewals`,
 *     `/admin/renewals/tasks`, `/admin/renewals/tier-upgrades`).
 * Rendered against real `en.json` (not a stub translator) so a missing/renamed
 * i18n key fails this suite instead of silently rendering the raw key at
 * runtime — see memory note "Real en.json render test".
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RenewalsSectionTabs } from '@/app/(staff)/admin/renewals/_components/renewals-section-tabs';
import en from '@/i18n/messages/en.json';

// Mutable navigation state so each test can simulate a different page's
// pathname + searchParams without re-mocking the module (mirrors the
// `nav` pattern in tests/unit/members/presentation/directory-filters-search-focus.test.tsx).
// `next/link` is intentionally NOT mocked — jsdom renders it as an <a href>,
// which is exactly what these href assertions read (same pattern as
// tests/unit/app/admin/renewals/pending-review-list.test.tsx).
const nav = vi.hoisted(() => ({
  pathname: '/admin/renewals',
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
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

function activeEntryText(container: HTMLElement): string | null {
  const active = container.querySelector('[aria-current="page"]');
  return active ? active.textContent : null;
}

function href(name: RegExp): string {
  return screen.getByRole('link', { name }).getAttribute('href') ?? '';
}

beforeEach(() => {
  nav.pathname = '/admin/renewals';
  nav.searchParams = new URLSearchParams();
});

describe('<RenewalsSectionTabs> active-state derivation (aria-current="page")', () => {
  it('/admin/renewals with no view param → Pipeline is current', () => {
    const { container } = renderTabs();
    expect(activeEntryText(container)).toBe('Pipeline');
  });

  it('/admin/renewals?view=pending-review → Pending review is current', () => {
    nav.searchParams = new URLSearchParams('view=pending-review');
    const { container } = renderTabs();
    expect(activeEntryText(container)).toBe('Pending review');
  });

  it("pathname starting /admin/renewals/tasks → Tasks is current regardless of that page's own params", () => {
    nav.pathname = '/admin/renewals/tasks';
    nav.searchParams = new URLSearchParams('status=open&assignment=mine');
    const { container } = renderTabs();
    expect(activeEntryText(container)).toBe('Tasks');
  });

  it('pathname starting /admin/renewals/tier-upgrades → Tier upgrades is current', () => {
    nav.pathname = '/admin/renewals/tier-upgrades';
    const { container } = renderTabs();
    expect(activeEntryText(container)).toBe('Tier upgrades');
  });

  it('exactly one entry is marked current', () => {
    const { container } = renderTabs();
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('non-current entries carry no aria-current', () => {
    renderTabs(); // pipeline route → Pipeline current
    expect(screen.getByRole('link', { name: /^pipeline$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: /pending review/i }),
    ).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /^tasks/i })).not.toHaveAttribute(
      'aria-current',
    );
    expect(
      screen.getByRole('link', { name: /tier upgrades/i }),
    ).not.toHaveAttribute('aria-current');
  });
});

describe('<RenewalsSectionTabs> nav landmark a11y label', () => {
  it('names the whole strip, not just the Pending-review entry', () => {
    renderTabs();
    expect(
      screen.getByRole('navigation', { name: 'Renewals sections' }),
    ).toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> hrefs — Tasks / Tier upgrades (plain route hrefs)', () => {
  it('Tasks links to /admin/renewals/tasks', () => {
    renderTabs();
    expect(href(/^tasks/i)).toBe('/admin/renewals/tasks');
  });

  it('Tier upgrades links to /admin/renewals/tier-upgrades', () => {
    renderTabs();
    expect(href(/tier upgrades/i)).toBe('/admin/renewals/tier-upgrades');
  });
});

describe('<RenewalsSectionTabs> hrefs — Pipeline / Pending review from the pipeline route', () => {
  it('Pending-review href drops tier + urgency + cursor (pending-review has no such filters)', () => {
    nav.searchParams = new URLSearchParams(
      'tier=premium&urgency=t-30&cursor=abc',
    );
    renderTabs();
    const url = href(/pending review/i);
    expect(url).not.toContain('tier=');
    expect(url).not.toContain('urgency=');
    expect(url).not.toContain('cursor=');
    expect(url).toContain('view=pending-review');
  });

  it('Pipeline href drops view but keeps tier/urgency', () => {
    nav.searchParams = new URLSearchParams('tier=premium&view=pending-review');
    renderTabs();
    const url = href(/^pipeline$/i);
    expect(url).toContain('tier=premium');
    expect(url).not.toContain('view=');
  });
});

describe('<RenewalsSectionTabs> hrefs — arriving FROM Tasks/Tier-upgrades (clean pipeline URL)', () => {
  it("Pipeline from the Tasks page ignores that page's own params", () => {
    nav.pathname = '/admin/renewals/tasks';
    nav.searchParams = new URLSearchParams('status=open&assignment=mine');
    renderTabs();
    expect(href(/^pipeline$/i)).toBe('/admin/renewals');
  });

  it('Pending review from the Tier-upgrades page lands on a clean pending-review URL', () => {
    nav.pathname = '/admin/renewals/tier-upgrades';
    nav.searchParams = new URLSearchParams();
    renderTabs();
    expect(href(/pending review/i)).toBe('/admin/renewals?view=pending-review');
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
 * Tier upgrades entries, so an admin sees pending work at a glance without
 * opening each one. Pipeline is deliberately excluded (default view, not a
 * work queue).
 *
 * `renderTabsWithCount` takes an OPTIONS OBJECT (not three positional args)
 * and omits absent keys entirely rather than assigning `undefined` — this
 * repo's `exactOptionalPropertyTypes: true` rejects `{ pendingReviewCount:
 * undefined }` against a `pendingReviewCount?: number` prop, so the
 * "undefined" case below calls `renderTabsWithCount({})` rather than passing
 * the key with an explicit `undefined` value.
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
  it('renders the count badge on the Pending review entry when count > 0', () => {
    renderTabsWithCount({ pendingReviewCount: 4 });
    const pendingLink = screen.getByRole('link', { name: /pending review/i });
    expect(pendingLink.textContent).toContain('4');
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
  it('renders the count badge on the Tasks entry when count > 0', () => {
    renderTabsWithCount({ tasksCount: 7 });
    const tasksLink = screen.getByRole('link', { name: /^tasks/i });
    expect(tasksLink.textContent).toContain('7');
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
  it('renders the count badge on the Tier upgrades entry when count > 0', () => {
    renderTabsWithCount({ tierUpgradeCount: 2 });
    const tierLink = screen.getByRole('link', { name: /tier upgrades/i });
    expect(tierLink.textContent).toContain('2');
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

describe('<RenewalsSectionTabs> Pipeline entry is never badged', () => {
  it('Pipeline shows no count badge even when the other three counts are set', () => {
    renderTabsWithCount({
      pendingReviewCount: 4,
      tasksCount: 7,
      tierUpgradeCount: 2,
    });
    const pipelineLink = screen.getByRole('link', { name: /^pipeline$/i });
    expect(pipelineLink.textContent).toBe('Pipeline');
  });
});

/**
 * Enhancement C2 (#4) — mobile horizontal scroll + touch targets.
 *
 * The four `whitespace-nowrap` links overflow a narrow viewport; the strip
 * must scroll inside its OWN `overflow-x-auto` container (never the page body),
 * keeping the help Popover trigger visible beside it. Touch targets are raised
 * to >=44px on coarse pointers (WCAG 2.5.5 / audit goal) while the compact
 * desktop (fine-pointer) height is left unchanged.
 */
describe('<RenewalsSectionTabs> C2 — mobile overflow + touch targets', () => {
  it('wraps the nav in a horizontal-scroll container (strip scrolls, not the page)', () => {
    renderTabs();
    const strip = screen.getByRole('navigation', { name: 'Renewals sections' });
    expect(strip.closest('.overflow-x-auto')).not.toBeNull();
  });

  it('the help Popover trigger stays beside the scroll container, not inside it', () => {
    renderTabs(true);
    const helpTrigger = screen.getByRole('button', {
      name: 'About the renewal pipeline',
    });
    // The scroll container clips the nav only; the help button must live
    // OUTSIDE it so it can never be scrolled out of reach.
    expect(helpTrigger.closest('.overflow-x-auto')).toBeNull();
  });

  it('raises each link tap target to >=44px on coarse pointers', () => {
    renderTabs();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link.className).toContain('pointer-coarse:min-h-11');
    }
  });
});
