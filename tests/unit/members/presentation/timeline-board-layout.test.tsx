/**
 * Spec 122 US3 — the activity timeline as on the Portal-timeline boards:
 * events under "Today" / "This month" / month headings, a caption saying how
 * many are shown, rows of title · detail over "actor · time" with an outline
 * source badge, and on phones every filter in AURA's Filters sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { TimelineStream } from '@/components/members/timeline-stream';
import { TimelineFilters } from '@/components/members/timeline-filters';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/portal/timeline',
}));

// 27 Sep 2026, 10:00 in Bangkok
const NOW = new Date('2026-09-27T03:00:00.000Z');

const EVENTS: TimelineItemProps[] = [
  { id: 'a', timestamp: '2026-09-27T03:03:00.000Z', source: 'payment', eventType: 'succeeded', actorKind: 'member', actorDisplayName: null, payload: null },
  { id: 'b', timestamp: '2026-09-22T07:10:00.000Z', source: 'audit', eventType: 'tax_receipt_issued', actorKind: 'staff', actorUserId: 'u1', actorDisplayName: 'Somchai P.', payload: { receipt_document_number_raw: 'RC-2026-000045' } },
  { id: 'c', timestamp: '2026-09-15T01:00:00.000Z', source: 'renewal', eventType: 'reminded', actorKind: 'system', actorDisplayName: null, payload: null },
  { id: 'd', timestamp: '2026-07-03T02:00:00.000Z', source: 'broadcast', eventType: 'sent', actorKind: 'member', actorDisplayName: null, payload: null },
];

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  search = new URLSearchParams();
});
afterEach(cleanup);

describe('the timeline on the Portal-timeline boards (spec 122 US3)', () => {
  it('groups events under Today, This month and a month heading, with a caption', () => {
    wrap(<TimelineStream fetchPath="/api/portal/timeline" initialEvents={EVENTS} initialCursor={null} emptyLabel="" listLabel="Activity timeline" />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([en.timeline.page.groupToday, en.timeline.page.groupThisMonth, 'July 2026']);
    expect(screen.getByText(/Showing the latest 4/)).toBeInTheDocument();
  });

  it('reads each row as title · detail over actor · time, with an outline source badge', () => {
    wrap(<TimelineStream fetchPath="/api/portal/timeline" initialEvents={EVENTS} initialCursor={null} emptyLabel="" listLabel="Activity timeline" />);
    const list = screen.getByRole('list', { name: 'Activity timeline' });
    const [today, receipt] = within(list).getAllByRole('listitem');
    expect(today).toHaveTextContent('Payment received');
    // under Today only the time shows
    expect(today!.querySelector('time')).toHaveTextContent(/^10:03$/);
    expect(today).toHaveTextContent(`${en.timeline.actorKind.member} · 10:03`);
    expect(within(today!).getByText(en.timeline.source.payment)).toHaveClass('aura-badge', 'is-outline');
    expect(within(receipt!).getByText('Tax receipt issued')).toBeInTheDocument();
    expect(within(receipt!).getByText('RC-2026-000045')).toBeInTheDocument();
    expect(receipt).toHaveTextContent(/Somchai P\. · 22 Sept?, 14:10/);
  });

  // Spec 122 (2026-10-15, AURA #146; maintainer): the timeline's own phone
  // "More filters" toggle gives way to AURA's Filters sheet, like every list.
  it('on phones folds every filter into AURA\'s Filters sheet, with no toggle of its own', () => {
    search = new URLSearchParams('actorKind=staff');
    const { container } = wrap(<TimelineFilters />);
    expect(screen.queryByRole('button', { name: /more filters/i })).toBeNull();
    const controls = container.querySelector('.aura-filterbar__controls')!;
    for (const name of ['source', 'actorKind', 'from', 'to']) {
      const field = controls.querySelector(`[name="${name}"]`)!.closest('.aura-field')!;
      expect(field.parentElement).toBe(controls);
    }
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-haspopup', 'dialog');
  });
});
