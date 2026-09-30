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

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PlansTable } from '@/components/plans/plans-table';
import type { Role } from '@/modules/auth/domain/role';
import type { PlanListItem } from '@/modules/plans';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Base UI Menu only renders its popup while open (pointer interactions jsdom
// does not model), so the row-menu primitives are inline stand-ins — same
// pattern as plan-detail-actions.test.tsx.
vi.mock('@/components/ui/dropdown-menu', () => {
  function DropdownMenu({ children }: { children?: React.ReactNode }) {
    return <div>{children}</div>;
  }
  function DropdownMenuTrigger({
    render: renderProp,
  }: {
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    return <>{renderProp ? renderProp({}) : null}</>;
  }
  function DropdownMenuContent({ children }: { children?: React.ReactNode }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({ children }: { children?: React.ReactNode }) {
    return (
      <button type="button" role="menuitem">
        {children}
      </button>
    );
  }
  function DropdownMenuSeparator() {
    return <hr />;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  };
});

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
    const itemsFor = (planId: string) =>
      within(document.querySelector(`tr[data-plan-id="${planId}"]`) as HTMLElement)
        .getAllByRole('menuitem')
        .map((b) => b.textContent);
    expect(itemsFor('active-plan')).not.toContain(DELETE);
    expect(itemsFor('inactive-plan')).toContain(DELETE);
  });
});
