/**
 * Task 16 (059-membership-suspension) — MembersTable renders a "Suspended"
 * badge BESIDE the Status badge when `row.membership_suspended` is true,
 * with screen-reader text. Mirrors the "Lapsed" badge test
 * (members-table-lapsed-badge.test.tsx) but for the NEW amber/suspended
 * state — distinct icon (PauseCircle vs TriangleAlert) + distinct colour
 * token (text-warning vs text-destructive, never colour-alone) + distinct
 * sr-only phrase.
 *
 * The badge is a SIBLING outside the InlineStatusCell button so clicking the
 * warning never fires the status toggle nor pollutes the button's accessible
 * name. Uses the real EN strings (admin.members.directory.membershipSuspended /
 * membershipSuspendedSr) so `t()` resolves to the shipped copy.
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

// Real EN strings for the keys under test (admin.members.directory).
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
        membershipSuspended: 'Suspended',
        membershipSuspendedSr: 'Membership suspended — benefits paused',
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
      detail: {
        inviteBounced: {
          badge: 'Invite bounced',
          badgeAria: 'Invitation email bounced',
        },
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
    membership_suspended: false,
    portal_state: null,
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

describe('MembersTable suspended badge', () => {
  it('renders the Suspended badge + SR text on a suspended row', () => {
    renderTable([baseRow({ membership_suspended: true })]);
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(
      screen.getByText('Membership suspended — benefits paused'),
    ).toBeInTheDocument();
  });

  it('renders NO Suspended badge on a non-suspended row', () => {
    renderTable([baseRow({ membership_suspended: false })]);
    expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
  });

  it('uses an amber (warning) colour token, never destructive red, for the Suspended badge', () => {
    renderTable([baseRow({ membership_suspended: true })]);
    const badge = screen.getByText('Suspended').closest('span[class]');
    expect(badge).not.toBeNull();
    expect(badge?.className).toMatch(/text-warning/);
    expect(badge?.className).not.toMatch(/text-destructive/);
  });

  it('suppresses the Suspended badge on an archived row even when suspended', () => {
    renderTable([baseRow({ status: 'archived', membership_suspended: true })]);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Membership suspended — benefits paused'),
    ).not.toBeInTheDocument();
  });

  it('keeps the Suspended badge OUTSIDE the status-toggle button (admin inline-edit)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={[baseRow({ membership_suspended: true })]}
          nextCursor={null}
          enableSelection
          onInlineEdit={vi.fn().mockResolvedValue({ ok: true })}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Suspended').closest('button')).toBeNull();
  });

  it('prefers the Lapsed (red) badge over Suspended when both flags are somehow true', () => {
    // Mutually exclusive by construction (deriveMembershipAccess never
    // returns both), but the render must still make a deterministic choice
    // rather than showing two conflicting badges.
    renderTable([
      baseRow({ membership_lapsed: true, membership_suspended: true }),
    ]);
    expect(screen.getByText('Lapsed')).toBeInTheDocument();
    expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
  });
});
