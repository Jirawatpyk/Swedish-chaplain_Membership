/**
 * F119 T115 (FR-026; contracts/dashboard-and-notifications.md § 1.2 "At phone
 * width") — below `md` the card carries member, subject, stage, whose turn
 * and time in stage; round and the proposed / confirmed send times move to
 * the detail page. No horizontal scroll and no hidden-column menu: the card
 * is a stack of labelled lines, never a squeezed table.
 *
 * UX review M7 — exactly those five fields: Audience, Recipients and
 * Submitted left the card (the test used to assert only that Round was
 * absent, so three extra fields rode along unnoticed). UX review H2 — plus
 * FR-029's delivery results on a sent row, which the card had dropped.
 * UX review M6 — the labels are muted, the values are not.
 *
 * The harness builds the SAME `useReactTable` config `queue-table-client.tsx`
 * uses (see `queue-card-list.test.tsx` for why `columns: []` is faithful).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { useReactTable, getCoreRowModel, type RowSelectionState } from '@tanstack/react-table';
import en from '@/i18n/messages/en.json';
import { QueueCardList } from '@/components/broadcast/admin/queue-card-list';
import type { EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

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

const ROW: EnrichedQueueRow = {
  broadcastId: 'b1',
  subject: 'Autumn gala',
  memberDisplayName: 'Acme Co',
  actorRoleLabel: null,
  segmentLabel: 'All members',
  recipientCount: 42,
  ageBadge: { label: '30 h waiting', variant: 'amber' },
  statusBadgeVariant: 'secondary',
  statusBadgeLabel: 'Member approved — awaiting schedule',
  actionable: false,
  whoseTurnLabel: 'Marketing',
  timeInStageLabel: '30 h',
  round: 3,
  proposedSendAtFormatted: '1 Oct 2026, 10:00',
  confirmedSendAtFormatted: '2 Oct 2026, 11:00',
  lastActivityFormatted: '22 Sep 2026, 09:00',
  deliverySummary: null,
};

function Harness({ rows }: { readonly rows: ReadonlyArray<EnrichedQueueRow> }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows as EnrichedQueueRow[],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: (r) => r.original.actionable,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
    getRowId: (r) => r.broadcastId,
  });
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <QueueCardList table={table} readOnly columnLabels={{ select: 'Select broadcast' }} />
    </NextIntlClientProvider>
  );
}

describe('<QueueCardList> — the phone-width columns (T115, FR-026)', () => {
  it('shows member, subject, stage, whose turn and time in stage', () => {
    render(<Harness rows={[ROW]} />);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getByText('Autumn gala')).toBeInTheDocument();
    expect(card.getByText('Acme Co')).toBeInTheDocument();
    expect(card.getByText('Member approved — awaiting schedule')).toBeInTheDocument();
    expect(card.getByText(/Whose turn/)).toBeInTheDocument();
    expect(card.getByText('Marketing')).toBeInTheDocument();
    expect(card.getByText(/Time in stage/)).toBeInTheDocument();
    // The SLA badge travels with time in stage, not with the submitted date.
    expect(card.getByText('30 h waiting')).toBeInTheDocument();
  });

  it('exactly the five phone-width fields: the only labelled lines are Whose turn and Time in stage — no Audience, Recipients or Submitted', () => {
    render(<Harness rows={[ROW]} />);
    const card = screen.getByRole('group', { name: 'Autumn gala' });
    const labels = Array.from(card.querySelectorAll('[data-slot="card-field-label"]')).map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(['Whose turn', 'Time in stage']);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByText(/Audience/)).toBeNull();
    expect(list.queryByText(/Recipients/)).toBeNull();
    expect(list.queryByText(/Submitted/)).toBeNull();
    expect(list.queryByText('All members')).toBeNull();
    expect(list.queryByText('42')).toBeNull();
  });

  it('a sent row carries its delivery results (FR-029, UX review H2); other rows carry none', () => {
    const summary = '40 recipients · 37 delivered · 2 bounced · 1 complained';
    render(
      <Harness
        rows={[
          { ...ROW, broadcastId: 'b-sent', subject: 'Sent one', deliverySummary: summary },
          { ...ROW, broadcastId: 'b-open', subject: 'Open one' },
        ]}
      />,
    );
    expect(within(screen.getByRole('group', { name: 'Sent one' })).getByText(summary)).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Open one' })).queryByText(/delivered/)).toBeNull();
  });

  it('the labels are muted and the values are not (UX review M6)', () => {
    render(<Harness rows={[ROW]} />);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getByText('Marketing').closest('.text-muted-foreground')).toBeNull();
    for (const label of screen
      .getByRole('group', { name: 'Autumn gala' })
      .querySelectorAll('[data-slot="card-field-label"]')) {
      expect(label).toHaveClass('text-muted-foreground');
    }
  });

  it('round and both send times are absent below md', () => {
    render(<Harness rows={[ROW]} />);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByText(/Round/)).toBeNull();
    expect(list.queryByText(/Proposed/)).toBeNull();
    expect(list.queryByText(/Confirmed/)).toBeNull();
    expect(list.queryByText('1 Oct 2026, 10:00')).toBeNull();
    expect(list.queryByText('2 Oct 2026, 11:00')).toBeNull();
  });

  it('a stage nobody is waiting on reads "—" for whose turn and time in stage', () => {
    render(<Harness rows={[{ ...ROW, whoseTurnLabel: null, timeInStageLabel: null, ageBadge: null }]} />);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getAllByText('—')).toHaveLength(2);
  });

  it('no squeezed table and no hidden-column menu inside the card list', () => {
    render(<Harness rows={[ROW]} />);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByRole('table')).toBeNull();
    expect(list.queryByRole('button')).toBeNull();
    expect(list.queryByRole('menu')).toBeNull();
  });
});
