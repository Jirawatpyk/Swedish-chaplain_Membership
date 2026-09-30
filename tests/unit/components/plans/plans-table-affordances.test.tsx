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
import { PlansTable } from '@/components/plans/plans-table';
import type { Role } from '@/modules/auth/domain/role';
import type { PlanListItem } from '@/modules/plans';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

afterEach(cleanup);

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

  it('puts the filters in one named group of AURA fields, with the same ids', () => {
    renderRows();
    const group = screen.getByRole('group', { name: en.admin.plans.filters.groupLabel });
    expect(within(group).getByRole('searchbox', { name: en.admin.plans.filters.search.label })).toHaveAttribute('id', 'plans-search');
    expect(within(group).getByRole('combobox', { name: en.admin.plans.filters.category.label })).toHaveAttribute('id', 'plans-category');
    expect(within(group).getByRole('combobox', { name: en.admin.plans.filters.year })).toHaveAttribute('id', 'plans-year');
    expect(within(group).getByRole('switch', { name: en.admin.plans.filters.activeOnly })).toHaveAttribute('id', 'plans-active-only');
    expect(within(group).getByRole('switch', { name: SHOW_DELETED })).toHaveAttribute('id', 'plans-show-deleted');
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

  it('ends with the count and the VAT note under the table', () => {
    renderRows();
    expect(screen.getByText('3 plans in 2026 · fees exclude 7% VAT')).toBeInTheDocument();
  });

  // UX review (US6): the plan name is the only way into a plan from a phone
  // card, so its link fills a 44px touch target there.
  it('gives the plan name link a 44px touch target on phones', () => {
    renderRows();
    expect(screen.getByRole('link', { name: 'Premium Corporate' })).toHaveClass('max-sm:min-h-11');
  });

  // Parity comments (US6): the switches sit on the fields' line from 640px
  // and stack with no grid gap on phones; the pill centres on the name line.
  it('keeps both switches in one wrapper that sits on the fields\' line', () => {
    renderRows();
    const group = screen.getByRole('group', { name: en.admin.plans.filters.groupLabel });
    const [activeOnly, showDeleted] = within(group).getAllByRole('switch');
    const wrapper = activeOnly?.closest('[data-plans-switches]');
    expect(wrapper).not.toBeNull();
    expect(showDeleted?.closest('[data-plans-switches]')).toBe(wrapper);
    expect(wrapper).toHaveClass('col-span-2', 'sm:self-end', 'sm:h-[var(--aura-input-height)]');
    // Stacked on a phone 44px apart, as the board draws them: AURA makes each
    // row 44px on a touch screen, so the stack adds no gap there (as AURA's
    // own radio list does), and a small one for a mouse's 20px rows.
    expect(wrapper).toHaveClass('gap-[var(--aura-space-3)]', 'max-sm:pointer-coarse:gap-0', 'sm:gap-[var(--aura-space-4)]');
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
    expect(screen.getByText(en.admin.plans.empty.filteredTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.admin.plans.empty.clearFilters })).toBeInTheDocument();
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
    const group = screen.getByRole('group', { name: en.admin.plans.filters.groupLabel });
    expect(within(group).getByRole('combobox', { name: en.admin.plans.filters.year })).toBeInTheDocument();
    expect(within(group).queryByRole('searchbox')).not.toBeInTheDocument();
    expect(within(group).getAllByRole('switch').map((sw) => sw.id)).toEqual(['plans-show-deleted']);
    expect(within(group).getAllByRole('combobox')).toHaveLength(1);
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
