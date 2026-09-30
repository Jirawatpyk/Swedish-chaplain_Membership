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
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RenewalsSectionTabs } from '@/app/(staff)/admin/renewals/_components/renewals-section-tabs';
import en from '@/i18n/messages/en.json';

/** AURA Select keeps a real <select> under its listbox: pick by changing it (US5a precedent). */
function pickNative(label: string, value: string) {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  if (!native) throw new Error(`no native select for ${label}`);
  fireEvent.change(native, { target: { value } });
}

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

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
  useRouter: () => ({ push }),
}));

function renderTabs() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsSectionTabs />
    </NextIntlClientProvider>,
  );
}

/** The AURA link tabs (the phone select is a separate control). */
function sections(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Renewals sections' });
}

function activeEntryText(container: HTMLElement): string | null {
  const active = container.querySelector('[aria-current="page"]');
  return active ? active.textContent : null;
}

function href(name: RegExp): string {
  return within(sections()).getByRole('link', { name }).getAttribute('href') ?? '';
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

// The old Base UI tablist suppressed clicks on the already-selected tab; the
// nav refactor keeps that a no-op by pointing the ACTIVE entry at the CURRENT
// url — so re-clicking the section you're on must NOT drop that page's own
// filters (the review-flagged regression).
describe('<RenewalsSectionTabs> hrefs — the ACTIVE entry preserves the current url', () => {
  it("active Tasks entry links to the current url (keeps its status/assignment/task_type filters)", () => {
    nav.pathname = '/admin/renewals/tasks';
    nav.searchParams = new URLSearchParams(
      'status=open&assignment=mine&task_type=director_call',
    );
    renderTabs();
    expect(href(/^tasks/i)).toBe(
      '/admin/renewals/tasks?status=open&assignment=mine&task_type=director_call',
    );
  });

  it('active Tier-upgrades entry links to the current url (keeps its params)', () => {
    nav.pathname = '/admin/renewals/tier-upgrades';
    nav.searchParams = new URLSearchParams('cursor=abc123');
    renderTabs();
    expect(href(/tier upgrades/i)).toBe(
      '/admin/renewals/tier-upgrades?cursor=abc123',
    );
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
      <RenewalsSectionTabs {...counts} />
    </NextIntlClientProvider>,
  );
}

describe('<RenewalsSectionTabs> pending-review count badge (item ④)', () => {
  it('renders the count badge on the Pending review entry when count > 0', () => {
    renderTabsWithCount({ pendingReviewCount: 4 });
    const pendingLink = screen.getByRole('link', { name: /pending review/i });
    expect(pendingLink.textContent).toContain('4');
    expect(pendingLink).toHaveAccessibleName('Pending review, 4 cycles awaiting review');
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ pendingReviewCount: 0 });
    expect(screen.queryByRole('link', { name: /awaiting review/i })).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(screen.queryByRole('link', { name: /awaiting review/i })).not.toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> tasks count badge (item ④ plan-wide decision)', () => {
  it('renders the count badge on the Tasks entry when count > 0', () => {
    renderTabsWithCount({ tasksCount: 7 });
    const tasksLink = screen.getByRole('link', { name: /^tasks/i });
    expect(tasksLink.textContent).toContain('7');
    expect(tasksLink).toHaveAccessibleName('Tasks, 7 open tasks');
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ tasksCount: 0 });
    expect(screen.queryByRole('link', { name: /open tasks?/i })).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(screen.queryByRole('link', { name: /open tasks?/i })).not.toBeInTheDocument();
  });
});

describe('<RenewalsSectionTabs> tier-upgrade count badge (item ④ plan-wide decision)', () => {
  it('renders the count badge on the Tier upgrades entry when count > 0', () => {
    renderTabsWithCount({ tierUpgradeCount: 2 });
    const tierLink = screen.getByRole('link', { name: /tier upgrades/i });
    expect(tierLink.textContent).toContain('2');
    expect(tierLink).toHaveAccessibleName('Tier upgrades, 2 tier-upgrade suggestions');
  });

  it('renders NO badge when count is 0 or undefined', () => {
    renderTabsWithCount({ tierUpgradeCount: 0 });
    expect(
      screen.queryByRole('link', { name: /tier-upgrade suggestion/i }),
    ).not.toBeInTheDocument();
    renderTabsWithCount({});
    expect(
      screen.queryByRole('link', { name: /tier-upgrade suggestion/i }),
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
 * 122 US7a (T703) — AURA link tabs on a desktop (board `Admin-renewals`), a
 * "Section" select on a phone (board `Admin-renewals-mobile`).
 */
describe('<RenewalsSectionTabs> AURA link tabs and the phone select', () => {
  it('the four sections are AURA link tabs', () => {
    renderTabs();
    expect(sections()).toHaveClass('aura-tabs');
    expect(within(sections()).getAllByRole('link')).toHaveLength(4);
  });

  it('a "Section" select lists the four sections, the current one chosen', () => {
    nav.pathname = '/admin/renewals/tasks';
    renderTabs();
    const select = screen.getByRole('combobox', { name: 'Section' });
    expect(select).toHaveTextContent('Tasks');
    const native = select.closest('.aura-select')?.querySelector('select');
    expect([...(native?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Pipeline',
      'Pending review',
      'Tasks',
      'Tier upgrades',
    ]);
  });

  it('choosing a section in the select navigates to that tab\'s href', () => {
    push.mockClear();
    nav.searchParams = new URLSearchParams('tier=premium&urgency=t-30');
    renderTabs();
    pickNative('Section', 'pending-review');
    expect(push).toHaveBeenCalledWith(href(/pending review/i));
  });
});
