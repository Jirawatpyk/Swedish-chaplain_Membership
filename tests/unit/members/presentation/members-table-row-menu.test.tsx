/**
 * 122 US5a (T502) — the members table on AURA `DataTable`.
 *
 * - Each row has a "⋯" menu holding only destinations that already exist
 *   (spec 122 Clarifications, Session 2026-09-28 US5 start): "Open member",
 *   plus "Edit member" when the viewer may edit members (`canEdit`).
 * - The company name is the row's link to the member detail page.
 * - A row checkbox is named after the company, not the row key (AURA names it
 *   from the key, a UUID, unless the table supplies the label).
 */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error minimal jsdom polyfill
    globalThis.PointerEvent = class extends MouseEvent {};
  }
});

afterEach(() => {
  cleanup();
});

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

const messages = {
  admin: {
    members: {
      directory: {
        columns: {
          memberNumber: 'Member No.',
          company: 'Company',
          plan: 'Plan',
          primaryContact: 'Primary contact',
          status: 'Status',
          engagement: 'Engagement',
          lastActivity: 'Last activity',
          actions: 'Actions',
        },
        rowActions: 'More actions for {company}',
        openMember: 'Open member',
        editMember: 'Edit member',
        rowAriaLabel: 'Open {company} details',
        noPrimary: 'No primary',
        tableCaption: 'Members directory',
        selectAll: 'Select all',
        selectRow: 'Select {company}',
        resultsCount: '{count} members',
        filters: { status: { active: 'Active', inactive: 'Inactive', archived: 'Archived' } },
      },
      inlineEdit: { toggleStatus: 'Toggle ({current})', saving: 'Saving', saved: 'Saved' },
    },
  },
};

const row: MembersTableRow = {
  member_id: '11111111-1111-4111-8111-111111111111',
  member_number_display: 'SCCM-0042',
  company_name: 'Zeta Holdings',
  country: 'TH',
  plan_id: 'corporate',
  plan_year: 2026,
  plan_display_name: 'Corporate',
  status: 'active',
  membership_lapsed: false,
  membership_suspended: false,
  portal_state: null,
  engagement: null,
  last_activity_at: null,
  primary_contact: null,
};

function renderTable(props: Partial<Parameters<typeof MembersTable>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={[row]} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('MembersTable on AURA DataTable (T502)', () => {
  it('renders an ARIA grid named after the table caption', () => {
    renderTable();
    expect(screen.getByRole('grid', { name: 'Members directory' })).toBeInTheDocument();
  });

  it('links the company name to the member detail page', () => {
    renderTable();
    const link = screen.getByRole('link', { name: /Zeta Holdings/ });
    expect(link).toHaveAttribute('href', `/admin/members/${row.member_id}`);
  });

  it('row menu offers "Open member" and, with canEdit, "Edit member"', () => {
    renderTable({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Zeta Holdings' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open member' })).toHaveAttribute(
      'href',
      `/admin/members/${row.member_id}`,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Edit member' })).toHaveAttribute(
      'href',
      `/admin/members/${row.member_id}/edit`,
    );
  });

  it('row menu has no "Edit member" without canEdit (manager)', () => {
    renderTable({ canEdit: false });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Zeta Holdings' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open member' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Edit member' })).toBeNull();
  });

  it('names each row checkbox after the company', () => {
    renderTable({ enableSelection: true, onSelectionChange: vi.fn() });
    expect(screen.getByRole('checkbox', { name: 'Select Zeta Holdings' })).toBeInTheDocument();
  });
});
