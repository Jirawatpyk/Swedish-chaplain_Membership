/**
 * 122 US5a — the members phone card as the `Admin-members-mobile` board draws
 * it (maintainer's decision, 28 Sep 2026): no checkbox, no ⋯ menu, no flag,
 * and four fields in the board's order — Member No., Plan (no year), Primary
 * contact, and the engagement band (no score); Last activity drops out. The
 * table on wider screens is unchanged. The card parts are AURA DataTable's
 * column options (`card`, `cardOrder`, `hideSelectionInCards`, handoff #80,
 * 5.13.0). Card mode itself is a container query jsdom cannot trigger, so
 * these tests pin the attributes AURA's card rules key on.
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

/** The grid cell holding a card slot. */
function cellOf(container: HTMLElement, slot: string): HTMLElement {
  const cell = container.querySelector(`[data-card-slot="${slot}"]`)?.closest<HTMLElement>('[role="gridcell"]');
  if (!cell) throw new Error(`no cell for ${slot}`);
  return cell;
}

describe('members phone card as on the board (US5a)', () => {
  it('drops the checkbox, the ⋯ menu and Last activity on a card, through AURA options', () => {
    const { container } = renderTable();
    expect(container.querySelector('.aura-table')).toHaveClass('aura-table--cards-nosel');
    expect(cellOf(container, 'activity')).toHaveAttribute('data-card', 'hide');
    const menu = screen.getByRole('button', { name: /More actions for Siam Nordic/ });
    expect(menu.closest('[role="gridcell"]')).toHaveAttribute('data-card', 'hide');
    // No reach into AURA's card classes is left.
    expect(container.querySelector('[data-members-table]')?.className).not.toContain('aura-table--stacked_');
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
    const order = ['number', 'plan', 'contact', 'engagement'].map((slot) => {
      const cell = cellOf(container, slot);
      expect(cell).toHaveAttribute('data-card', 'field');
      return Number(cell.style.getPropertyValue('--aura-card-order'));
    });
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts the status pill flush right on a card: the hover-only pencil takes no room there', () => {
    // The pencil shows only on hover / focus, but it kept its width on a card,
    // pushing the pill ~20px off the edge and out of line with Suspended.
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable rows={[row]} total={1} enableSelection canEdit onInlineEdit={vi.fn()} />
      </NextIntlClientProvider>,
    );
    const toggle = screen.getByRole('button', { name: /Active/ });
    expect(toggle).toHaveClass('in-[.aura-table--stacked]:px-0');
    expect(toggle.querySelector('svg.lucide-pencil')).toHaveClass('in-[.aura-table--stacked]:hidden');
  });
});

