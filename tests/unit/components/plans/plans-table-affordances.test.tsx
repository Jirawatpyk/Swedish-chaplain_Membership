// tests/unit/components/plans/plans-table-affordances.test.tsx
//
// 016 polish (I6) — the PlansTable mutation affordances (show-deleted switch,
// actions column, empty-state New-plan/Clone CTAs) key on the `plans.write`
// permission, not on an admin-tier role check. The distinguishing cases:
//
//   - `manager` holds `plans.read` (renders the page) but NOT `plans.write` —
//     it must see a read-only table. A key mix-up onto `plans.read` would show
//     it every CTA, and this suite goes red.
//   - `marketing` cannot even reach `/admin/plans` (no `plans.read`), but the
//     component is pinned anyway as defence-in-depth for a future page-guard
//     mistake.
//
// Rendered with an EMPTY plans list: the toolbar + empty-state carry every
// affordance this suite asserts, and no row fixtures are needed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AuraProvider } from '@jirawatpyk/aura-react';
import en from '@/i18n/messages/en.json';
import sv from '@/i18n/messages/sv.json';
import { PlansTable } from '@/components/plans/plans-table';
import type { Role } from '@/modules/auth/domain/role';
import type { PlanListItem } from '@/modules/plans';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: nav.replace }),
  usePathname: () => '/admin/plans',
  useSearchParams: () => nav.search.current,
}));

function renderTable(
  role: Role,
  opts: { year?: number; plans?: ReadonlyArray<PlanListItem> } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlansTable
        plans={opts.plans ?? []}
        currencyCode="THB"
        year={opts.year ?? 2026}
        currentUserRole={role}
        initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }}
      />
    </NextIntlClientProvider>,
  );
}

const SHOW_DELETED = en.admin.plans.filters.showDeleted;
const NEW_CTA = en.admin.plans.empty.newCta;
const DELETE = en.admin.plans.actions.delete;

function planRow(planId: string, isActive: boolean): PlanListItem {
  return {
    plan_id: planId,
    plan_year: 2026,
    plan_name: { en: planId },
    description: { en: '' },
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 3_600_000,
    vat_rate: 7,
    total_with_vat_minor_units: 3_852_000,
    includes_corporate_plan_id: null,
    is_active: isActive,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sort_order: 1,
    missing_translations: [],
  } as PlanListItem;
}

afterEach(() => {
  cleanup();
  nav.replace.mockClear();
  nav.search.current = new URLSearchParams();
});

describe('PlansTable mutation affordances follow plans.write', () => {
  it.each(['admin', 'super_admin'] as const)('%s sees the CTAs', (role) => {
    renderTable(role);
    expect(screen.getByText(SHOW_DELETED)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: new RegExp(NEW_CTA, 'i') })).toHaveAttribute(
      'href',
      '/admin/plans/new',
    );
  });

  it.each(['manager', 'marketing', 'member'] as const)('%s sees a read-only table', (role) => {
    renderTable(role);
    expect(screen.queryByText(SHOW_DELETED)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: new RegExp(NEW_CTA, 'i') })).not.toBeInTheDocument();
  });
});

// 122 US6 (T602) — the list on AURA as the `Admin-plans` board draws it.
function listItem(overrides: Partial<PlanListItem>): PlanListItem {
  return {
    plan_id: 'premium',
    plan_year: 2026,
    plan_name: { en: 'Premium Corporate' },
    description: null,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 3_600_000,
    vat_rate: 0.07,
    total_with_vat_minor_units: 3_852_000,
    includes_corporate_plan_id: null,
    is_active: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sort_order: 40,
    missing_translations: [],
    ...overrides,
  } as PlanListItem;
}

describe('PlansTable on AURA (board Admin-plans)', () => {
  const plans = [
    listItem({}),
    listItem({ plan_id: 'diamond', plan_name: { en: 'Diamond Partnership' }, plan_category: 'partnership', sort_order: 10, annual_fee_minor_units: 20_000_000 }),
    listItem({ plan_id: 'alumni', plan_name: { en: 'Thai Alumni/Student' }, member_type_scope: 'individual', is_active: false, sort_order: 90, annual_fee_minor_units: 100_000 }),
  ];

  function renderRows() {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlansTable
          plans={plans}
          currencyCode="THB"
          year={2026}
          currentUserRole="admin"
          initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }}
        />
      </NextIntlClientProvider>,
    );
  }

  // The filter pattern (docs/aura-adoption.md § Filters, layout review 2 Oct):
  // AURA's FilterBar — search, then Year, then Category, then toggle chips.
  it('puts the filters in an AURA FilterBar: search, Year, Category, then the toggle chips', () => {
    renderRows();
    const bar = screen.getByRole('region', { name: en.admin.plans.filters.groupLabel });
    expect(within(bar).getByRole('searchbox', { name: en.admin.plans.filters.search.label })).toBeInTheDocument();
    const year = within(bar).getByRole('combobox', { name: en.admin.plans.filters.year });
    const category = within(bar).getByRole('combobox', { name: en.admin.plans.filters.category.label });
    expect(year.compareDocumentPosition(category) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of [en.admin.plans.filters.activeOnly, SHOW_DELETED]) {
      const chip = within(bar).getByRole('button', { name });
      expect(chip).toHaveAttribute('aria-pressed', 'false');
      expect(chip).toHaveClass('aura-tag--touch');
    }
    expect(within(bar).queryByRole('switch')).toBeNull();
  });

  it('shows the result count at the end of the filter row', () => {
    const { container } = renderRows();
    expect(container.querySelector('.aura-filterbar__count')).toHaveTextContent('3 results');
  });

  it('filters as you pick: a toggle chip writes the URL at once, in place', () => {
    renderRows();
    fireEvent.click(screen.getByRole('button', { name: en.admin.plans.filters.activeOnly }));
    expect(nav.replace).toHaveBeenCalledWith('/admin/plans?activeOnly=true', { scroll: false });
  });

  it('shows an applied category as a chip, with Clear all', () => {
    nav.search.current = new URLSearchParams('category=corporate');
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlansTable
          plans={plans}
          currencyCode="THB"
          year={2026}
          currentUserRole="admin"
          initialFilter={{ category: 'corporate', q: null, activeOnly: false, showDeleted: false }}
        />
      </NextIntlClientProvider>,
    );
    const bar = screen.getByRole('region', { name: en.admin.plans.filters.groupLabel });
    expect(within(bar).getByText('Category: Corporate')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: /clear filters/i }));
    expect(nav.replace).toHaveBeenCalledWith('/admin/plans', { scroll: false });
    // UX review H1: the button unmounts; focus lands on the search, not <body>.
    expect(within(bar).getByRole('searchbox')).toHaveFocus();
  });

  it('removing a chip keeps focus in the bar, on the search; the chip × is named "Remove filter: …"', () => {
    nav.search.current = new URLSearchParams('category=corporate');
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlansTable
          plans={plans}
          currencyCode="THB"
          year={2026}
          currentUserRole="admin"
          initialFilter={{ category: 'corporate', q: null, activeOnly: false, showDeleted: false }}
        />
      </NextIntlClientProvider>,
    );
    const bar = screen.getByRole('region', { name: en.admin.plans.filters.groupLabel });
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove filter: Category: Corporate' }));
    expect(within(bar).getByRole('searchbox')).toHaveFocus();
  });

  it('makes the ghost Clear filters beside a lone toggle 44px on touch', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlansTable
          plans={plans}
          currencyCode="THB"
          year={2026}
          currentUserRole="admin"
          initialFilter={{ category: null, q: null, activeOnly: true, showDeleted: false }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('button', { name: /clear filters/i })).toHaveClass('aura-btn--touch');
  });

  it('lists the plans in an AURA table, partnership first, with badges, pills and a right-aligned fee', () => {
    const { container } = renderRows();
    const table = container.querySelector('table');
    expect(table).toHaveClass('aura-tbl');
    const rows = [...container.querySelectorAll('tbody tr[data-plan-id]')];
    expect(rows.map((r) => r.getAttribute('data-plan-id'))).toEqual(['diamond', 'premium', 'alumni']);
    expect(rows[0]).toHaveAttribute('data-plan-year', '2026');
    const diamond = rows[0] as HTMLElement;
    expect(within(diamond).getByRole('link', { name: 'Diamond Partnership' })).toHaveAttribute('href', '/admin/plans/2026/diamond');
    expect(within(diamond).getByText(en.admin.plans.badges.partnership)).toHaveClass('aura-badge');
    expect(within(diamond).getByText(en.admin.plans.badges.active).closest('.aura-pill')).not.toBeNull();
    expect(within(rows[2] as HTMLElement).getByText(en.admin.plans.badges.inactive).closest('.aura-pill')).not.toBeNull();
    expect(within(diamond).getByText('200,000.00 THB').closest('td')).toHaveClass('is-numeric');
  });

  it('opens each row\'s actions from an AURA menu named for the plan', () => {
    renderRows();
    const trigger = screen.getByRole('button', { name: 'Actions for Premium Corporate' });
    expect(trigger).toHaveClass('aura-icon-btn');
    expect(trigger).toHaveAttribute('data-row-actions-trigger');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      en.admin.plans.actions.edit,
      en.admin.plans.actions.deactivate,
    ]);
  });

  // Parity (US6): the staff pages are compact; since AURA 5.20 (#115) the
  // static Table takes the page's density, so the table sets none itself.
  it('takes the page\'s density, compact on the staff pages', () => {
    const { container, unmount } = renderRows();
    expect(container.querySelector('.aura-tbl-wrap')).not.toHaveAttribute('data-density', 'compact');
    unmount();
    const staff = render(
      <AuraProvider density="compact">
        <NextIntlClientProvider locale="en" messages={en}>
          <PlansTable plans={plans} currencyCode="THB" year={2026} currentUserRole="admin" initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }} />
        </NextIntlClientProvider>
      </AuraProvider>,
    );
    expect(staff.container.querySelector('.aura-tbl-wrap')).toHaveAttribute('data-density', 'compact');
  });

  // FR-020 (spec 004): the column labels stay in view while the rows scroll.
  // AURA 5.26 (#129): Table stickyHeader pins the header row to the page.
  it('pins its header row to the page while the rows scroll (stickyHeader)', () => {
    const { container } = renderRows();
    expect(container.querySelector('.aura-tbl-wrap')).toHaveClass('is-sticky-page');
  });

  it('ends with the VAT note under the table (the count is in the filter row)', () => {
    renderRows();
    expect(screen.getByText('Fees exclude 7% VAT')).toBeInTheDocument();
  });

  // The rate in the note is formatted for the UI locale like every other VAT
  // rate in the admin (formatVatRateBps) — a raw `7.5` read "7.5 %" in Swedish.
  it('formats a fractional rate in the VAT note for the UI locale', () => {
    const { container } = render(
      <NextIntlClientProvider locale="sv" messages={sv}>
        <PlansTable
          plans={[listItem({ vat_rate: 0.075 })]}
          currencyCode="THB"
          year={2026}
          currentUserRole="admin"
          initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }}
        />
      </NextIntlClientProvider>,
    );
    const note = Array.from(container.querySelectorAll('p')).find((p) =>
      p.textContent?.startsWith('Avgifter exkl.'),
    );
    expect(note?.textContent).toBe('Avgifter exkl. 7,5 % moms');
  });

  // UX review (US6): the plan name is the only way into a plan from a phone
  // card, so its link fills a 44px touch target there.
  it('gives the plan name link a 44px touch target on phones', () => {
    renderRows();
    expect(screen.getByRole('link', { name: 'Premium Corporate' })).toHaveClass('max-sm:min-h-11');
  });

  it('centres the status pill on the name line of a phone card', () => {
    renderRows();
    expect(screen.getAllByText(en.admin.plans.badges.active)[0]?.closest('td')).toHaveClass('self-center');
  });
});

// UX review (US6): filters that hide every plan of a year that has plans say
// so and offer to clear them, rather than "No plans for this year" and a
// clone the server would refuse.
describe('PlansTable filtered-empty state', () => {
  function renderFiltered(filter: { category: 'corporate' | null; q: string | null; activeOnly: boolean; showDeleted: boolean }) {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlansTable plans={[]} currencyCode="THB" year={2026} currentUserRole="admin" initialFilter={filter} />
      </NextIntlClientProvider>,
    );
  }

  it('says no plan matches and offers Clear filters instead of New / Clone', () => {
    renderFiltered({ category: null, q: 'zzz', activeOnly: false, showDeleted: false });
    const empty = screen.getByText(en.admin.plans.empty.filteredTitle).closest('.aura-empty') as HTMLElement;
    // The filter bar offers the same reset; this one sits in the table's empty state.
    expect(within(empty).getByRole('button', { name: en.admin.plans.empty.clearFilters })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: new RegExp(NEW_CTA, 'i') })).not.toBeInTheDocument();
  });

  it('keeps the year-empty state when only the year is chosen', () => {
    renderFiltered({ category: null, q: null, activeOnly: false, showDeleted: false });
    expect(screen.getByText(en.admin.plans.empty.title)).toBeInTheDocument();
  });

  // Board `Admin-state-plans-empty`: a year with no plans shows the Year
  // filter — nothing else can narrow an empty year — and, for plans.write,
  // Show deleted, the one way back to plans that were all deleted.
  it('shows only the Year filter and Show deleted for a year with no plans', () => {
    renderFiltered({ category: null, q: null, activeOnly: false, showDeleted: false });
    const bar = screen.getByRole('region', { name: en.admin.plans.filters.groupLabel });
    expect(within(bar).getByRole('combobox', { name: en.admin.plans.filters.year })).toBeInTheDocument();
    expect(within(bar).queryByRole('searchbox')).not.toBeInTheDocument();
    expect(within(bar).getAllByRole('combobox')).toHaveLength(1);
    expect(within(bar).getByRole('button', { name: SHOW_DELETED })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: en.admin.plans.filters.activeOnly })).toBeNull();
    // UX review L2: no "0 results" beside "No plans for this year".
    expect(bar.querySelector('.aura-filterbar__count')).toBeNull();
  });

  // Parity comment (US6): AURA's EmptyState pads itself, as on the members
  // list; the cell adds nothing on top.
  it('lets the empty state keep AURA\'s own padding', () => {
    renderFiltered({ category: null, q: null, activeOnly: false, showDeleted: false });
    expect(screen.getByText(en.admin.plans.empty.title).closest('td')).not.toHaveClass('py-12');
  });

  // Parity comment (US6): on a phone the empty state is no card field, so it
  // carries no "Name" label, and its two actions stack at one full width.
  it('shows the empty state unlabelled on a phone card, its actions stacked full width', () => {
    renderFiltered({ category: null, q: null, activeOnly: false, showDeleted: false });
    expect(screen.getByText(en.admin.plans.empty.title).closest('td')).not.toHaveAttribute('data-label');
    const newCta = screen.getByRole('link', { name: new RegExp(NEW_CTA, 'i') });
    expect(newCta.parentElement).toHaveClass('max-sm:flex-col', 'max-sm:items-stretch');
  });
});

describe('PlansTable empty-state Clone CTA', () => {
  it('clones INTO the year being viewed (from = year − 1, to = year)', () => {
    renderTable('admin', { year: 2028 });
    const cta = en.admin.plans.empty.cloneCta
      .replace('{sourceYear}', '2027')
      .replace('{targetYear}', '2028');
    expect(screen.getByRole('link', { name: cta })).toHaveAttribute(
      'href',
      '/admin/plans/clone?from=2027&to=2028',
    );
  });
});

describe('PlansTable row menu — Delete follows the plan lifecycle', () => {
  it('offers Delete only on inactive plans (active must be deactivated first)', () => {
    renderTable('admin', { plans: [planRow('active-plan', true), planRow('inactive-plan', false)] });
    const itemsFor = (planId: string) => {
      fireEvent.click(screen.getByRole('button', { name: `Actions for ${planId}` }));
      const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      return items;
    };
    expect(itemsFor('active-plan')).not.toContain(DELETE);
    expect(itemsFor('inactive-plan')).toContain(DELETE);
  });
});

// The list card rule (docs/aura-adoption.md § List card): from 640px up the table
// runs edge to edge inside the card (AURA `bleed`, 5.27 #130), keeping its header band.
describe('plans table in the list card', () => {
  it('bleeds to the card edges; the VAT note follows it, so it does not end the card', () => {
    const { container } = renderTable('admin', { plans: [listItem({})] });
    expect(container.querySelector('.aura-bleed')).not.toBeNull();
    expect(container.querySelector('.aura-bleed-end')).toBeNull();
  });
});
