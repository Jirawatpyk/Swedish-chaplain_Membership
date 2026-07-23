/**
 * Task 7 (057-members-portal-status) — `PortalBadge` renders in the Contact
 * cell for each `portal_state`, renders nothing for `null`/'unknown', and
 * the invite-bounced badge is suppressed once the state also explains the
 * bounce (expired or active — one root cause, one recovery).
 *
 * Uses the real `src/i18n/messages/en.json` (not a stub) so a missing key
 * fails this test, per the convention in
 * `tests/unit/members/bundle-change-warning-dialog.test.tsx`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  MembersTable,
  type MembersTableRow,
} from '@/components/members/members-table';

// MembersTable reads useRouter/usePathname/useSearchParams from
// 'next/navigation' (sort headers, load-more, Ctrl+A). No router context
// exists under plain RTL render, so mock it — same shape as
// members-table-lapsed-badge.test.tsx / members-table-suspended-badge.test.tsx.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

function row(overrides: Partial<MembersTableRow>): MembersTableRow {
  return {
    member_id: 'm-default',
    member_number_display: 'SCCM-0001',
    company_name: 'Test Co',
    country: 'TH',
    plan_id: 'plan-a',
    plan_year: 2026,
    plan_display_name: 'Corporate Gold',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    engagement: null,
    last_activity_at: null,
    portal_state: null,
    primary_contact: {
      contact_id: 'c-default',
      first_name: 'Anna',
      last_name: 'Berg',
      email: 'anna@example.com',
      invite_bounced: false,
    },
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

describe('portal status badge', () => {
  it('renders the portal label for each state', () => {
    renderTable([
      row({ member_id: 'm1', portal_state: 'active' }),
      row({ member_id: 'm2', portal_state: 'invited' }),
      row({ member_id: 'm3', portal_state: 'invite_expired' }),
      row({ member_id: 'm4', portal_state: 'not_invited' }),
    ]);
    expect(screen.getByText('Portal')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Not invited')).toBeInTheDocument();
  });

  it('renders no portal badge for unknown state', () => {
    renderTable([row({ member_id: 'm5', portal_state: 'unknown' })]);
    expect(screen.queryByText('Portal')).not.toBeInTheDocument();
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });

  it('renders no portal badge when the member has no primary contact', () => {
    renderTable([row({ member_id: 'm6', portal_state: null, primary_contact: null })]);
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });

  it('suppresses the invite-bounced badge when the invitation also expired', () => {
    renderTable([
      row({
        member_id: 'm7',
        portal_state: 'invite_expired',
        primary_contact: {
          contact_id: 'c7',
          first_name: 'Bounced',
          last_name: 'Expired',
          email: 'b@example.com',
          invite_bounced: true,
        },
      }),
    ]);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    // Two red MailWarning badges for one root cause is the a11y double-badge
    // finding the detail page already fixed ([memberId]/page.tsx:415-417).
    expect(
      screen.queryByText(messages.admin.members.detail.inviteBounced.badge),
    ).not.toBeInTheDocument();
  });

  it('suppresses the invite-bounced badge once the contact is active', () => {
    renderTable([
      row({
        member_id: 'm8',
        portal_state: 'active',
        primary_contact: {
          contact_id: 'c8',
          first_name: 'Bounced',
          last_name: 'ThenActive',
          email: 'c@example.com',
          invite_bounced: true,
        },
      }),
    ]);
    expect(
      screen.queryByText(messages.admin.members.detail.inviteBounced.badge),
    ).not.toBeInTheDocument();
  });

  it('renders no portal badge on an archived row', () => {
    renderTable([
      row({ member_id: 'm9', status: 'archived', portal_state: 'not_invited' }),
    ]);
    expect(screen.queryByText('Not invited')).not.toBeInTheDocument();
  });
});
