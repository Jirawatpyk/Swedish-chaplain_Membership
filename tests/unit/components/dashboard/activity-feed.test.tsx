/**
 * F9 `ActivityFeed` rendering (dashboard bug hunt 2026-07-11).
 *
 * Bug 3/7: each row shows the RELATIVE label as visible text, keeps the raw ISO
 * on the `<time dateTime>` attribute (machine-readable), and exposes the exact
 * tenant-timezone instant as the `title` tooltip.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ActivityFeed, type ActivityFeedEntry } from '@/components/dashboard/activity-feed';

const PROPS = {
  title: 'Recent activity',
  emptyLabel: 'No recent activity',
  refreshLabel: 'Refresh',
  refreshedLabel: 'Refreshed',
};

describe('ActivityFeed', () => {
  it('renders the relative label as text with the ISO dateTime and tenant-tz title', () => {
    const items: readonly ActivityFeedEntry[] = [
      {
        id: 'a1',
        label: 'Payment recorded',
        occurredAt: '2026-07-10T22:00:00.000Z',
        timeLabel: '5 minutes ago',
        absoluteLabel: '11/07/2026, 05:00',
      },
    ];

    render(<ActivityFeed {...PROPS} items={items} />);

    const time = screen.getByText('5 minutes ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', '2026-07-10T22:00:00.000Z');
    expect(time).toHaveAttribute('title', '11/07/2026, 05:00');
  });

  it('renders the actor name before the action label when present', () => {
    const items: readonly ActivityFeedEntry[] = [
      {
        id: 'a1',
        actor: 'Jane Doe',
        label: 'Payment recorded',
        occurredAt: '2026-07-10T22:00:00.000Z',
        timeLabel: '5 minutes ago',
      },
    ];
    render(<ActivityFeed {...PROPS} items={items} />);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText(/Payment recorded/)).toBeInTheDocument();
  });

  it('renders the action label as a link to the related record when href is present', () => {
    const href = '/admin/audit?targetRef=3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const items: readonly ActivityFeedEntry[] = [
      {
        id: 'a1',
        actor: 'Jane Doe',
        label: 'Member updated',
        href,
        occurredAt: '2026-07-10T22:00:00.000Z',
        timeLabel: '5 minutes ago',
      },
    ];
    render(<ActivityFeed {...PROPS} items={items} />);
    const link = screen.getByRole('link', { name: 'Member updated' });
    expect(link).toHaveAttribute('href', href);
  });

  it('renders the action label as plain text (no link) when href is absent', () => {
    const items: readonly ActivityFeedEntry[] = [
      {
        id: 'a1',
        label: 'System reminder sent',
        occurredAt: '2026-07-10T22:00:00.000Z',
        timeLabel: '5 minutes ago',
      },
    ];
    render(<ActivityFeed {...PROPS} items={items} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('System reminder sent')).toBeInTheDocument();
  });

  it('shows the empty state when there are no items', () => {
    render(<ActivityFeed {...PROPS} items={[]} />);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });
});
