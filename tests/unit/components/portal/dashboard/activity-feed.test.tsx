import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CreditCard } from 'lucide-react';
import {
  ActivityFeed,
  type ActivityFeedItem,
} from '@/components/portal/dashboard/activity-feed';
import enMessages from '@/i18n/messages/en.json';

function renderFeed(items: readonly ActivityFeedItem[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ActivityFeed items={items} viewAllHref="/portal/timeline" />
    </NextIntlClientProvider>,
  );
}

describe('<ActivityFeed>', () => {
  it('renders the section title as a real h2', () => {
    renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice INV-2026-0001 paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
    ]);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Recent activity');
  });

  it('renders one list item per activity with its text and a <time> element', () => {
    renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice INV-2026-0001 paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
      {
        id: '2',
        icon: CreditCard,
        text: 'Broadcast "Spring news" sent',
        iso: '2026-06-04T09:00:00.000Z',
      },
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Invoice INV-2026-0001 paid')).toBeDefined();
    // RelativeTime renders a <time dateTime> element per item.
    expect(document.querySelectorAll('time')).toHaveLength(2);
  });

  it('renders the localised empty state when there are no items', () => {
    renderFeed([]);
    // portal.dashboard.activity.empty.title / .body
    expect(screen.getByText('No activity yet')).toBeDefined();
    expect(
      screen.getByText(/Your invoices, benefit usage and broadcasts/i),
    ).toBeDefined();
    // No list rendered in the empty state.
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders a view-all link only when items are present', () => {
    const { rerender } = renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
    ]);
    expect(
      screen.getByRole('link', { name: 'View all activity' }).getAttribute('href'),
    ).toBe('/portal/timeline');

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ActivityFeed items={[]} viewAllHref="/portal/timeline" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('link', { name: 'View all activity' })).toBeNull();
  });
});
