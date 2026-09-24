/**
 * F119 T109 (US4-AS1, FR-025) — selecting a stage changes the list, and the
 * change is announced through the list's ONE existing `role="status"` region
 * (the permanently-mounted announcer in `queue-table-client.tsx`) — never a
 * second one.
 *
 * A stage change is a server re-render with a new `rows` array: the client
 * tree stays mounted, so the SAME region must survive it and its TEXT must
 * change (only a mutation of an already-mounted live region is announced
 * reliably). That holds for a read-only manager too, and for a change that
 * empties the list — the empty state renders INSIDE the component that owns
 * the region instead of replacing it.
 *
 * Every rerender builds a fresh element (RTL bails out of re-rendering the
 * same element instance).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueWithBulk } from '@/components/broadcast/admin/queue-with-bulk';
import type { EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: ns } as unknown as Parameters<
      typeof createTranslator
    >[0]),
  ),
  getLocale: vi.fn(async () => 'en'),
}));

import { QueueTable } from '@/components/broadcast/admin/queue-table';

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
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(cleanup);

function makeRow(id: string): EnrichedQueueRow {
  return {
    broadcastId: id,
    subject: `Subject ${id}`,
    memberDisplayName: 'Acme Co',
    actorRoleLabel: null,
    segmentLabel: 'All members',
    recipientCount: 42,
    ageBadge: null,
    statusBadgeVariant: 'secondary',
    statusBadgeLabel: 'Awaiting review',
    actionable: true,
    whoseTurnLabel: 'Marketing',
    timeInStageLabel: '3 h',
    round: 0,
    proposedSendAtFormatted: null,
    confirmedSendAtFormatted: null,
    lastActivityFormatted: '1 Aug 2026, 07:00',
    deliverySummary: null,
  };
}

const LABELS = {
  member: 'Member',
  subject: 'Subject',
  audience: 'Audience',
  sendTime: 'Send time',
  status: 'Stage',
  whoseTurn: 'Whose turn',
  timeInStage: 'Time in stage',
  actions: 'Actions',
  select: 'Select broadcast',
  tableAria: 'Broadcast review queue',
};

// UX review H3 — the page passes the VIEW total; here the page IS the view.
function queue(rows: EnrichedQueueRow[], readOnly: boolean) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueWithBulk rows={rows} readOnly={readOnly} columnLabels={LABELS} viewTotal={rows.length} />
    </NextIntlClientProvider>
  );
}

const regions = (root: HTMLElement) => root.querySelectorAll('[role="status"]');

describe('the queue announces a stage change through its ONE live region (T109)', () => {
  it.each([
    ['an admin', false],
    ['a read-only manager', true],
  ] as const)('%s: exactly one live region is mounted after the change, the same element, and its text announces the new count', (_who, readOnly) => {
    const { container, rerender } = render(queue([makeRow('b1'), makeRow('b2'), makeRow('b3')], readOnly));
    expect(regions(container)).toHaveLength(1);
    const region = regions(container)[0]!;
    // Nothing is announced on the first paint — only a CHANGE is news.
    expect(region).toHaveTextContent('');

    rerender(queue([makeRow('b2')], readOnly));

    expect(regions(container)).toHaveLength(1);
    expect(regions(container)[0]).toBe(region);
    expect(region).toHaveTextContent('1 E-Blast in this view');
  });

  it('a change that empties the list keeps the region and says so', () => {
    const { container, rerender } = render(queue([makeRow('b1')], false));
    const region = regions(container)[0]!;
    rerender(queue([], false));
    expect(regions(container)).toHaveLength(1);
    expect(regions(container)[0]).toBe(region);
    expect(region).toHaveTextContent('No E-Blasts in this view');
  });

  it('the server wrapper renders the empty state INSIDE the region owner — one region, no swap to a region-less block', async () => {
    const ui = await QueueTable({ rows: [], readOnly: false });
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {ui}
      </NextIntlClientProvider>,
    );
    expect(regions(container)).toHaveLength(1);
    expect(screen.getByText('Queue is clear')).toBeInTheDocument();
  });
});
