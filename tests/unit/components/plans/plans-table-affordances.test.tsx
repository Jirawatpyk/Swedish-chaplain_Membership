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
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PlansTable } from '@/components/plans/plans-table';
import type { Role } from '@/modules/auth/domain/role';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function renderTable(role: Role) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlansTable
        plans={[]}
        currencyCode="THB"
        year={2026}
        currentUserRole={role}
        initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }}
      />
    </NextIntlClientProvider>,
  );
}

const SHOW_DELETED = en.admin.plans.filters.showDeleted;
const NEW_CTA = en.admin.plans.empty.newCta;

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
