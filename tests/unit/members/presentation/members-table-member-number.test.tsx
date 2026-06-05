/**
 * ADMIN-4 (055-member-number) — MembersTable renders a member-number column
 * with a formatted display value and a sortable header button.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error minimal jsdom polyfill
    globalThis.PointerEvent = class extends MouseEvent {};
  }
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

const messages = {
  admin: {
    members: {
      directory: {
        sortByMemberNumber: 'Sort by member number',
        sortByEngagement: 'Sort by engagement',
        columns: {
          memberNumber: 'Member No.',
          company: 'Company',
          country: 'Country',
          plan: 'Plan',
          year: 'Year',
          primaryContact: 'Primary contact',
          status: 'Status',
          risk: 'Risk',
          engagement: 'Engagement',
          lastActivity: 'Last activity',
          notes: 'Notes',
        },
        engagementBand: { healthy: 'H', moderate: 'M', warning: 'W', critical: 'C' },
        riskNotComputed: 'Not yet scored',
        riskNotComputedAria: 'Risk score not yet computed',
        riskNotComputedTooltip: 'later',
        riskPlaceholder: '—',
        rowAriaLabel: 'Open {company} details',
        noPrimary: 'No primary',
        loadMore: 'Load more',
        tableCaption: 'Members directory',
        selectAll: 'Select all',
        selectRow: 'Select {company}',
        managerReadOnlyBanner: 'Read-only',
        searchPlaceholder: 'Search',
        searchSrLabel: 'Search',
        clearFilters: 'Clear',
        resultsCount: '{count} members',
        filters: {
          status: { label: 'Status', all: 'All', active: 'Active', inactive: 'Inactive', archived: 'Archived' },
          plan: { label: 'Plan', all: 'All plans' },
          risk: { label: 'Risk', all: 'All', healthy: 'Healthy', warning: 'Warning', 'at-risk': 'At-risk', critical: 'Critical' },
        },
      },
      inlineEdit: {
        columnHeaderHintTooltip: 'edit',
        statusLabel: 'Status',
        countryLabel: 'Country',
        notesLabel: 'Notes',
        saveButton: 'Save',
        cancelButton: 'Cancel',
        savedAria: 'Saved',
        errorAria: 'Error',
        savingAria: 'Saving',
        savedToast: 'Saved',
        errorToast: 'Error',
        hintDoubleClick: 'double-click',
      },
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
  member_risk_flag: null,
  engagement: null,
  last_activity_at: null,
  notes: null,
  primary_contact: null,
};

describe('MembersTable member number column', () => {
  it('renders the formatted member number and a sort header', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable rows={[row]} nextCursor={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sort by member number' }),
    ).toBeInTheDocument();
  });
});
