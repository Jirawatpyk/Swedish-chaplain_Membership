/**
 * 057 code-review F1 — <RecentActivityList> markup validity.
 *
 * `TimelineEventItem` renders a <div>; an <ol> whose direct children are
 * non-<li> elements fails axe's `list` rule (WCAG 1.3.1). This pins that
 * every row is wrapped in an <li> with aria-setsize/posinset (mirrors
 * timeline-stream.tsx).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RecentActivityList } from '@/app/(member)/portal/_components/recent-activity-list';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

const EVENTS: TimelineItemProps[] = [
  {
    id: 'e1',
    timestamp: '2026-06-01T00:00:00.000Z',
    source: 'invoice',
    eventType: 'invoice_issued',
    actorKind: 'system',
    actorDisplayName: null,
    payload: null,
  },
  {
    id: 'e2',
    timestamp: '2026-06-02T00:00:00.000Z',
    source: 'payment',
    eventType: 'payment_succeeded',
    actorKind: 'member',
    actorDisplayName: null,
    payload: null,
  },
];

function renderList(events: TimelineItemProps[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RecentActivityList events={events} />
    </NextIntlClientProvider>,
  );
}

describe('<RecentActivityList>', () => {
  afterEach(cleanup);

  it('renders an <ol> list', () => {
    renderList(EVENTS);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('renders one <li> per event — every <ol> direct child is an <li>', () => {
    renderList(EVENTS);
    const list = screen.getByRole('list');
    // role=listitem is exposed for <li> inside <ol>.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(EVENTS.length);
    // Direct children of the <ol> must ALL be <li> (axe `list` rule).
    for (const child of Array.from(list.children)) {
      expect(child.tagName).toBe('LI');
    }
  });

  it('sets aria-setsize/posinset on each <li> for SR position context', () => {
    renderList(EVENTS);
    const items = screen.getAllByRole('listitem');
    items.forEach((li, i) => {
      expect(li).toHaveAttribute('aria-setsize', String(EVENTS.length));
      expect(li).toHaveAttribute('aria-posinset', String(i + 1));
    });
  });
});
