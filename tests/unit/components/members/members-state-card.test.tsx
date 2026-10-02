/**
 * 122 US5a — the members state boards (`Admin-state-members-filtered`,
 * `-error`): the filters and the empty / error state share one card, and the
 * error is drawn in the danger colours (red border, red icon on a red disc).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { MembersErrorState, MembersStateCard } from '@/components/members/empty-states';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

function renderIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('members state card (US5a)', () => {
  it('frames the filters and the state in one card', () => {
    renderIntl(
      <MembersStateCard>
        <p>filters</p>
        <p>state</p>
      </MembersStateCard>,
    );
    const card = screen.getByText('filters').closest('[data-members-state-card]');
    expect(card).not.toBeNull();
    expect(card).toBe(screen.getByText('state').closest('[data-members-state-card]'));
    // The list card rule: an AURA card that drops its frame below 640px,
    // where the rows become cards of their own.
    expect(card).toHaveClass('aura-card', 'aura-card--flush-below-sm');
  });

  it('draws the error state in the danger colours', () => {
    renderIntl(<MembersErrorState />);
    // AURA 5.13 (handoff #82): EmptyState's own danger tone, on the alert
    // itself — no wrapper restyling AURA's classes.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('aura-empty', 'is-danger', 'is-bordered');
  });
});
