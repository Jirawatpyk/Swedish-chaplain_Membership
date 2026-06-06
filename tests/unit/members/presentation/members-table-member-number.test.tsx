/**
 * ADMIN-4 (055-member-number) — MembersTable renders a member-number column
 * with a formatted display value and a sortable header button.
 *
 * FIX-C (code-review round-2) — guard aria-sort on the <th> (columnheader):
 *   - ?sort=memberNumber&order=asc  → Member No. <th> aria-sort="ascending"
 *   - ?sort=memberNumber&order=desc → Member No. <th> aria-sort="descending"
 *   - ?sort=memberNumber (no order) → aria-sort="ascending" (column default ASC)
 *   - ?sort=engagement   (no order) → Engagement <th> aria-sort="descending" (default DESC)
 */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Mutable ref so individual tests can override the search-params without
// re-calling vi.mock (same pattern as pay-sheet.test.tsx / pay-now-button.test.tsx).
const searchParamsMock = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => searchParamsMock.current,
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

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={[row]} nextCursor={null} />
    </NextIntlClientProvider>,
  );
}

describe('MembersTable member number column', () => {
  it('renders the formatted member number and a sort header', () => {
    searchParamsMock.current = new URLSearchParams();
    renderTable();
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sort by member number' }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FIX-C: aria-sort on the <th> (columnheader) — guards the relocation from
// FIX-3 and the per-column default logic from FIX-A.
//
// The `role=columnheader` is the <th> rendered by TanStack Table's TableHead.
// We pick it by its accessible name (the text content of the header cell).
// ---------------------------------------------------------------------------
describe('MembersTable aria-sort on <th> (FIX-C)', () => {
  it('?sort=memberNumber&order=asc → Member No. <th> has aria-sort="ascending"', () => {
    searchParamsMock.current = new URLSearchParams('sort=memberNumber&order=asc');
    renderTable();
    const th = screen.getByRole('columnheader', { name: /Member No\./i });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
  });

  it('?sort=memberNumber&order=desc → Member No. <th> has aria-sort="descending"', () => {
    searchParamsMock.current = new URLSearchParams('sort=memberNumber&order=desc');
    renderTable();
    const th = screen.getByRole('columnheader', { name: /Member No\./i });
    expect(th).toHaveAttribute('aria-sort', 'descending');
  });

  it('?sort=memberNumber (no order) → aria-sort="ascending" (proves FIX-A: column default ASC)', () => {
    searchParamsMock.current = new URLSearchParams('sort=memberNumber');
    renderTable();
    const th = screen.getByRole('columnheader', { name: /Member No\./i });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
  });

  it('?sort=engagement (no order) → Engagement <th> has aria-sort="descending" (column default DESC)', () => {
    searchParamsMock.current = new URLSearchParams('sort=engagement');
    renderTable();
    const th = screen.getByRole('columnheader', { name: /Engagement/i });
    expect(th).toHaveAttribute('aria-sort', 'descending');
  });

  it('no sort params → neither column carries aria-sort', () => {
    searchParamsMock.current = new URLSearchParams();
    renderTable();
    const memberNoTh = screen.getByRole('columnheader', { name: /Member No\./i });
    const engagementTh = screen.getByRole('columnheader', { name: /Engagement/i });
    expect(memberNoTh).not.toHaveAttribute('aria-sort');
    expect(engagementTh).not.toHaveAttribute('aria-sort');
  });
});
