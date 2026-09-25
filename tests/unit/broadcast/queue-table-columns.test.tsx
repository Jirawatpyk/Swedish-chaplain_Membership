/**
 * F119 dashboard UX review M1 / M6 / H3 / H4 (2026-09-24) — the desktop table
 * and the one live region.
 *
 *   - M1: eight columns (plus selection) so Actions stays on a 1,280-1,440 px
 *     screen — Member · Subject · Stage · Whose turn · Time in stage · Send
 *     time · Audience · Actions. Every FR-026 field is still on the row: the
 *     round under the Stage badge, last activity as Time in stage's "since"
 *     line, the proposed AND confirmed send times in Send time (the proposal
 *     on a second line when the confirmed time differs from it), the recipient
 *     count in Audience. The sorted column carries `aria-sort`, and a visible
 *     hint says the order.
 *   - M6: muted type is for labels and the "—" sentinel, never a real value.
 *   - H3: the announcement counts the VIEW (`viewTotal`), not the page; with
 *     no total it says "shown", and stalled is always "shown".
 *   - H4: a change of VIEW is announced even when the words are the same —
 *     each announcement is a new node in the region.
 *
 * Rendered under a real `NextIntlClientProvider` backed by `en.json`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  QueueTableClient,
  type EnrichedQueueRow,
  type QueueTableClientProps,
} from '@/components/broadcast/admin/queue-table-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

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

const LABELS: QueueTableClientProps['columnLabels'] = {
  member: 'Member',
  subject: 'Subject',
  status: 'Stage',
  whoseTurn: 'Whose turn',
  timeInStage: 'Time in stage',
  sendTime: 'Send time',
  audience: 'Audience',
  actions: 'Actions',
  select: 'Select broadcast',
  tableAria: 'Broadcast review queue',
};

function makeRow(overrides: Partial<EnrichedQueueRow> = {}): EnrichedQueueRow {
  return {
    broadcastId: 'b1',
    subject: 'Autumn gala',
    memberDisplayName: 'Acme Co',
    actorRoleLabel: null,
    segmentLabel: 'All members',
    recipientCount: 42,
    ageBadge: null,
    statusBadgeVariant: 'secondary',
    statusBadgeLabel: 'Scheduled',
    actionable: false,
    whoseTurnLabel: null,
    timeInStageLabel: null,
    round: 2,
    proposedSendAtFormatted: '1 Oct 2026, 10:00',
    confirmedSendAtFormatted: '2 Oct 2026, 11:00',
    lastActivityFormatted: '22 Sep 2026, 09:00',
    deliverySummary: null,
    ...overrides,
  };
}

function table(props: Partial<QueueTableClientProps> & { rows: ReadonlyArray<EnrichedQueueRow> }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueTableClient columnLabels={LABELS} {...props} />
    </NextIntlClientProvider>
  );
}

const headers = () =>
  within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map((th) => th.textContent?.trim() ?? '');

const cellOf = (column: string) => {
  const index = headers().indexOf(column);
  const firstRow = within(screen.getByRole('table')).getAllByRole('row')[1]!;
  return within(firstRow).getAllByRole('cell')[index]!;
};

describe('the eight columns (UX review M1)', () => {
  it('an admin sees selection + exactly Member · Subject · Stage · Whose turn · Time in stage · Send time · Audience · Actions', () => {
    render(table({ rows: [makeRow()] }));
    expect(headers()).toEqual([
      '',
      'Member',
      'Subject',
      'Stage',
      'Whose turn',
      'Time in stage',
      'Send time',
      'Audience',
      'Actions',
    ]);
  });

  it('Stage carries the round; Time in stage carries the "since" date (last activity)', () => {
    render(table({ rows: [makeRow()], readOnly: true }));
    expect(within(cellOf('Stage')).getByText('Scheduled')).toBeInTheDocument();
    expect(within(cellOf('Stage')).getByText('Round 2')).toBeInTheDocument();
    expect(within(cellOf('Time in stage')).getByText('since 22 Sep 2026, 09:00')).toBeInTheDocument();
  });

  it('a row never formatted shows no round line', () => {
    render(table({ rows: [makeRow({ round: 0 })], readOnly: true }));
    expect(within(cellOf('Stage')).queryByText(/Round/)).toBeNull();
  });

  it('Send time shows the confirmed time, and the proposal on a second line when it differs', () => {
    render(table({ rows: [makeRow()], readOnly: true }));
    const cell = cellOf('Send time');
    expect(within(cell).getByText('2 Oct 2026, 11:00')).toBeInTheDocument();
    expect(within(cell).getByText('1 Oct 2026, 10:00')).toBeInTheDocument();
    expect(within(cell).getByText('Proposed')).toBeInTheDocument();
  });

  it('Send time shows only the confirmed time when the proposal was kept', () => {
    render(table({ rows: [makeRow({ proposedSendAtFormatted: '2 Oct 2026, 11:00' })], readOnly: true }));
    const cell = cellOf('Send time');
    expect(within(cell).getByText('2 Oct 2026, 11:00')).toBeInTheDocument();
    expect(within(cell).queryByText('Proposed')).toBeNull();
  });

  it('before marketing confirms, Send time shows the proposal marked "Proposed"', () => {
    render(table({ rows: [makeRow({ confirmedSendAtFormatted: null })], readOnly: true }));
    const cell = cellOf('Send time');
    expect(within(cell).getByText('1 Oct 2026, 10:00')).toBeInTheDocument();
    expect(within(cell).getByText('Proposed')).toBeInTheDocument();
  });

  it('with neither time Send time reads "—"', () => {
    render(
      table({ rows: [makeRow({ confirmedSendAtFormatted: null, proposedSendAtFormatted: null })], readOnly: true }),
    );
    expect(cellOf('Send time')).toHaveTextContent('—');
  });

  it('Audience carries the segment and the recipient count', () => {
    render(table({ rows: [makeRow()], readOnly: true }));
    expect(cellOf('Audience')).toHaveTextContent('All members · 42');
  });

  it.each([
    ['longest_in_stage', 'Time in stage', 'descending', 'Sorted by longest in stage'],
    ['most_recent', 'Time in stage', 'ascending', 'Sorted by most recent first'],
    ['send_time', 'Send time', 'ascending', 'Sorted by send time'],
  ] as const)('order %s: `aria-sort` on %s (%s) and the visible hint', (order, column, direction, hint) => {
    render(table({ rows: [makeRow()], readOnly: true, order }));
    const sorted = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .filter((th) => th.hasAttribute('aria-sort'));
    expect(sorted).toHaveLength(1);
    expect(sorted[0]).toHaveTextContent(column);
    expect(sorted[0]).toHaveAttribute('aria-sort', direction);
    expect(screen.getByTestId('queue-order-hint')).toHaveTextContent(hint);
  });
});

describe('muted type is for labels only (UX review M6)', () => {
  it('the Audience value is not muted', () => {
    render(table({ rows: [makeRow()], readOnly: true }));
    expect(within(cellOf('Audience')).getByText(/All members/).closest('.text-muted-foreground')).toBeNull();
  });
});

describe('the live region counts the view and hears every change (UX review H3, H4)', () => {
  const region = () => screen.getByTestId('queue-selection-announcer');

  it('announces the VIEW total the page passes, not the page length', () => {
    const { rerender } = render(table({ rows: [makeRow()], viewTotal: 1, viewKey: 'a' }));
    rerender(table({ rows: [makeRow({ broadcastId: 'b2' })], viewTotal: 132, viewKey: 'b' }));
    expect(region()).toHaveTextContent('132 E-Blasts in this view');
  });

  it('with no known total it says "shown", and stalled is counted on the rows shown', () => {
    const stalled = makeRow({ broadcastId: 'b3', ageBadge: { label: 'Stalled — 3 days', variant: 'red' } });
    const { rerender } = render(table({ rows: [makeRow()], viewKey: 'a' }));
    rerender(table({ rows: [makeRow({ broadcastId: 'b2' }), stalled], viewTotal: null, viewKey: 'b' }));
    expect(region()).toHaveTextContent('2 E-Blasts shown, 1 stalled shown');
  });

  it('a change of view that lands on the same rows is still announced — a new node, the same words', () => {
    const rows = [makeRow()];
    const { rerender } = render(table({ rows, viewTotal: 1, viewKey: 'status=submitted' }));
    rerender(table({ rows, viewTotal: 1, viewKey: 'status=submitted&status=sent' }));
    const first = region().firstElementChild;
    expect(first).not.toBeNull();
    expect(region()).toHaveTextContent('1 E-Blast in this view');
    rerender(table({ rows, viewTotal: 1, viewKey: 'status=sent' }));
    expect(region().firstElementChild).not.toBe(first);
    expect(region()).toHaveTextContent('1 E-Blast in this view');
  });
});
