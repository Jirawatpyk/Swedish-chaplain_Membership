/**
 * 122 US5a — the members phone card as the `Admin-members-mobile` board draws
 * it (maintainer's decision, 28 Sep 2026): no checkbox, no ⋯ menu, no flag,
 * and four fields in the board's order — Member No., Plan (no year), Primary
 * contact, and the engagement band (no score); Last activity drops out. The
 * table on wider screens is unchanged. Card mode is AURA's
 * `.aura-table--stacked`, a container query jsdom cannot trigger, so these
 * tests pin the card-only rules the table carries.
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

const row: MembersTableRow = {
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

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MembersTable rows={[row]} total={1} enableSelection canEdit />
    </NextIntlClientProvider>,
  );
}

const CARD_HIDDEN = 'in-[.aura-table--stacked]:hidden';

describe('members phone card as on the board (US5a)', () => {
  it('drops the checkbox, the ⋯ menu and Last activity on a card', () => {
    const { container } = renderTable();
    const wrapper = container.querySelector('[data-members-table]');
    expect(wrapper?.className).toContain(String.raw`[&_.aura-table--stacked_.aura-table\_\_sel]:hidden`);
    expect(wrapper?.className).toContain("[&_.aura-table--stacked_[data-card='actions']]:hidden");
    expect(container.querySelector('[data-card-slot="activity"]')).not.toBeNull();
  });

  it('hides the flag, the plan year and the engagement score on a card, keeping the band', () => {
    const { container } = renderTable();
    expect(container.querySelector('[data-card-slot="flag"]')).toHaveClass(CARD_HIDDEN);
    expect(screen.getByText('2026').closest(`[class*="${CARD_HIDDEN}"]`)).not.toBeNull();
    expect(screen.getByText('82')).toHaveClass(CARD_HIDDEN);
    expect(screen.getByText('Healthy').closest(`[class*="${CARD_HIDDEN}"]`)).toBeNull();
  });

  it('orders the card fields as the board: Member No., Plan, Primary contact, engagement', () => {
    const { container } = renderTable();
    for (const slot of ['number', 'plan', 'contact', 'engagement']) {
      expect(container.querySelector(`[data-card-slot="${slot}"]`)).not.toBeNull();
    }
  });
});
