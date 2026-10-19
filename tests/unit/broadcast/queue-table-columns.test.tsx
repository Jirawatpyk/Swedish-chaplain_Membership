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
    statusTone: 'progress',
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
  within(screen.getByRole('grid'))
    .getAllByRole('columnheader')
    .map((th) => th.textContent?.trim() ?? '');

const cellOf = (column: string) => {
  const index = headers().indexOf(column);
  const firstRow = within(screen.getByRole('grid')).getAllByRole('row')[1]!;
  return within(firstRow).getAllByRole('gridcell')[index]!;
};

describe('the columns (UX review M1; parity comments 19 Oct)', () => {
  // Parity comments (19 Oct): "Whose turn" is a line under the Stage pill, so
  // Stage gets the width for a one-line pill. Every FR-026 field stays on the row.
  it('an admin sees selection + exactly Member · Subject · Stage · Time in stage · Send time · Audience · Actions', () => {
    render(table({ rows: [makeRow()] }));
    expect(headers()).toEqual([
      'Select rows',
      'Member',
      'Subject',
      'Stage',
      'Time in stage',
      'Send time',
      'Audience',
      'Actions',
    ]);
  });

  // Spec 122 US12b — AURA's DataTable gives an unsized column a 160 px
  // minimum, so eight of them pushed Actions out of a 1,440 px screen. Each
  // column now states the minimum its content needs. On a 1,280 px screen the
  // grid is 959 px: 40 px of selection and 48 px of row gutters leave 871 px.
  it('fits Actions on a 1,280 px screen: the column minimums add up to at most 871 px', () => {
    render(table({ rows: [makeRow()] }));
    const minimums = within(screen.getByRole('grid'))
      .getAllByRole('columnheader')
      .slice(1)
      .map((th) => {
        const style = th.getAttribute('style') ?? '';
        const px = /--aura-cell-(?:min|w):\s*(\d+)px/.exec(style)?.[1];
        return Number(px ?? 160);
      });
    expect(minimums.reduce((sum, px) => sum + px, 0)).toBeLessThanOrEqual(871);
  });

  it('the rows are only as wide as those minimums (stand-in until AURA #159)', () => {
    render(table({ rows: [makeRow()] }));
    const box = screen.getByRole('grid').closest<HTMLElement>('[style*="--queue-row-min"]');
    expect(box).toHaveClass('[&_.aura-table\\_\\_row]:min-w-[var(--queue-row-min)]');
    expect(box?.style.getPropertyValue('--queue-row-min')).toBe(
      'calc(868px + 2 * var(--aura-space-6) + var(--aura-table-select-width))',
    );
  });

  it('a long stage name wraps inside its pill instead of running into the next column (stand-in until AURA #158)', () => {
    render(table({ rows: [makeRow()] }));
    const pill = cellOf('Stage').querySelector('.aura-pill');
    expect(pill?.parentElement).toHaveClass('[&_.aura-pill]:whitespace-normal');
  });

  it('Stage is wide enough for a one-line pill, and a pill that still wraps is a rounded box, not a blob', () => {
    render(table({ rows: [makeRow()] }));
    const stage = within(screen.getByRole('grid'))
      .getAllByRole('columnheader')
      .find((th) => th.textContent?.trim() === 'Stage')!;
    expect(stage.getAttribute('style')).toMatch(/--aura-cell-min:\s*200px/);
    expect(cellOf('Stage').querySelector('.aura-pill')?.parentElement).toHaveClass(
      '[&_.aura-pill]:rounded-[var(--aura-radius-lg)]',
    );
  });

  // Maintainer (19 Oct): Approve and Reject side by side where the screen
  // allows (~214 px), stacked at 1,280 where the columns are at their minimums.
  it('Actions has a minimum, not a fixed width, and takes a bigger share of spare width (stand-in until AURA #162)', () => {
    render(table({ rows: [makeRow()] }));
    const actions = within(screen.getByRole('grid'))
      .getAllByRole('columnheader')
      .find((th) => th.textContent?.trim() === 'Actions')!;
    expect(actions.getAttribute('style')).toMatch(/--aura-cell-min:\s*128px/);
    expect(actions.getAttribute('style')).not.toMatch(/--aura-cell-w:/);
    const box = screen.getByRole('grid').closest<HTMLElement>('[style*="--queue-row-min"]');
    expect(box).toHaveClass(
      '[&_.aura-table\\_\\_th:has(+.aura-table\\_\\_gutter--end)]:grow-[2.5]',
      '[&_.aura-table\\_\\_td:has(+.aura-table\\_\\_break)]:grow-[2.5]',
    );
  });

  it('a read-only table has no Actions column and gives no column the bigger share', () => {
    render(table({ rows: [makeRow()], readOnly: true }));
    const box = screen.getByRole('grid').closest<HTMLElement>('[style*="--queue-row-min"]');
    expect(box?.className).not.toContain('grow-[2.5]');
  });

  it('whose turn is a line under the Stage pill, named by its label; none when nobody is waiting', () => {
    render(table({ rows: [makeRow({ whoseTurnLabel: 'Marketing' }), makeRow({ broadcastId: 'b2' })] }));
    expect(cellOf('Stage')).toHaveTextContent(/Whose turn:\s*Marketing/);
    const second = within(screen.getByRole('grid')).getAllByRole('row')[2]!;
    expect(second).not.toHaveTextContent(/Whose turn/);
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
    const sorted = within(screen.getByRole('grid'))
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
    expect(within(cellOf('Audience')).getByText(/All members/).closest('[class*="aura-fg-secondary"]')).toBeNull();
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
