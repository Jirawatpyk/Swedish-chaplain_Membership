/**
 * #4 (067) — MembersTable renders a "Lapsed" badge BESIDE the Status badge
 * when `row.membership_lapsed` is true, with screen-reader text.
 *
 * The badge is a SIBLING outside the InlineStatusCell button so clicking the
 * warning never fires the status toggle nor pollutes the button's accessible
 * name. Uses the real EN strings (admin.members.directory.membershipLapsed /
 * membershipLapsedSr) so `t()` resolves to the shipped copy.
 *
 * Mirrors the render setup of members-table-selection.test.tsx.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  MembersTable,
  type MembersTableRow,
} from '@/components/members/members-table';

// Base UI Checkbox uses PointerEvent internally; jsdom lacks it.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

afterEach(() => {
  cleanup();
});

// Mock sonner so toast calls don't explode in jsdom.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

// Real EN strings for the two keys under test (admin.members.directory).
const messages = {
  admin: {
    members: {
      directory: {
        selectAll: 'Select all',
        selectRow: 'Select {company}',
        selectedCount: '{count} selected',
        columns: {
          memberNumber: 'Member No.',
          company: 'Company',
          plan: 'Plan',
          primaryContact: 'Primary contact',
          status: 'Status',
          engagement: 'Engagement',
          lastActivity: 'Last activity',
        },
        statusActive: 'Active',
        statusInactive: 'Inactive',
        statusArchived: 'Archived',
        filters: {
          status: {
            active: 'Active',
            inactive: 'Inactive',
            archived: 'Archived',
          },
        },
        membershipLapsed: 'Lapsed',
        membershipLapsedSr: 'Membership lapsed — needs renewal',
        sortByMemberNumber: 'Sort by member number',
        sortByEngagement: 'Sort by engagement',
        engagementBand: { healthy: 'H', moderate: 'M', warning: 'W', critical: 'C' },
        rowAriaLabel: 'Open {company}',
        noPrimary: 'No primary',
        loadMore: 'Load more',
        tableCaption: 'Members directory',
      },
      inlineEdit: {
        columnHeaderHintTooltip: 'edit',
        statusUpdated: 'Updated',
        saveFailed: 'Failed',
        saving: 'Saving',
        saved: 'Saved',
        toggleStatus: 'Toggle ({current})',
        networkError: 'Network error',
      },
    },
  },
};

function baseRow(overrides: Partial<MembersTableRow> = {}): MembersTableRow {
  return {
    member_id: 'aaaa-1111-bbbb-2222',
    member_number_display: 'SCCM-0042',
    company_name: 'Fogmaker AB',
    country: 'SE',
    plan_id: 'plan-1',
    plan_year: 2026,
    plan_display_name: 'Premium Corporate',
    status: 'active',
    membership_lapsed: false,
    engagement: null,
    last_activity_at: null,
    primary_contact: null,
    ...overrides,
  };
}

function renderTable(rows: MembersTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={rows} nextCursor={null} />
    </NextIntlClientProvider>,
  );
}

describe('MembersTable lapsed badge', () => {
  it('renders the Lapsed badge + SR text on a lapsed row', () => {
    renderTable([baseRow({ membership_lapsed: true })]);
    expect(screen.getByText('Lapsed')).toBeInTheDocument();
    expect(
      screen.getByText('Membership lapsed — needs renewal'),
    ).toBeInTheDocument();
  });

  it('renders NO Lapsed badge on a non-lapsed row', () => {
    renderTable([baseRow({ membership_lapsed: false })]);
    expect(screen.queryByText('Lapsed')).not.toBeInTheDocument();
  });
});
