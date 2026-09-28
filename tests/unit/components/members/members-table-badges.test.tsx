/**
 * 122 US5a — the members table's badges as the `Admin-members` board draws
 * them: an unscored member reads "Not yet scored" (outline) instead of a
 * dash, Critical and Suspended are solid danger (Suspended with a ban
 * sign), Lapsed is a neutral status pill, and Archived carries one icon.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

const D = messages.admin.members.directory;

const base: MembersTableRow = {
  member_id: 'm1',
  member_number_display: 'TSCC-0003',
  company_name: 'Siam Nordic Trading Co., Ltd.',
  country: 'TH',
  plan_id: 'premium',
  plan_year: 2026,
  plan_display_name: 'Premium Corporate',
  status: 'active',
  membership_lapsed: false,
  membership_suspended: false,
  engagement: { score: 82, band: 'healthy' },
  last_activity_at: '2026-09-26T10:00:00Z',
  portal_state: 'active',
  primary_contact: { contact_id: 'c1', first_name: 'Erik', last_name: 'Johansson', email: 'e@example.com', invite_bounced: false },
} as MembersTableRow;

function renderRows(rows: MembersTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={rows} total={rows.length} />
    </NextIntlClientProvider>,
  );
}

describe('members table badges as on the board (US5a)', () => {
  it('says "Not yet scored" in an outline badge for an unscored member', () => {
    renderRows([{ ...base, engagement: null }]);
    const badge = screen.getByText(D.riskNotComputed);
    expect(badge.closest('.aura-badge')).toHaveClass('is-outline');
  });

  it('shows Critical as a solid danger badge', () => {
    renderRows([{ ...base, engagement: { score: 12, band: 'critical' } }]);
    const badge = screen.getByText(D.engagementBand.critical).closest('.aura-badge');
    expect(badge).toHaveClass('aura-badge--danger', 'is-solid');
  });

  it('shows Suspended as a solid danger badge with a ban sign', () => {
    renderRows([{ ...base, membership_suspended: true }]);
    const badge = screen.getByText(D.membershipSuspended).closest('.aura-badge');
    expect(badge).toHaveClass('aura-badge--danger', 'is-solid');
    expect(badge?.querySelector('svg.lucide-ban')).not.toBeNull();
  });

  it('shows Lapsed as a neutral status pill', () => {
    renderRows([{ ...base, status: 'inactive', membership_lapsed: true }]);
    expect(screen.getByText(D.membershipLapsed).closest('.aura-pill')).toHaveClass('aura-pill--neutral');
  });

  it('gives Archived one icon', () => {
    renderRows([{ ...base, status: 'archived' }]);
    const label = screen.getAllByText(D.filters.status.archived).find((el) => el.closest('[data-members-table]'))!;
    const badge = label.closest('.aura-badge, .aura-pill') as HTMLElement;
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
  });
});
