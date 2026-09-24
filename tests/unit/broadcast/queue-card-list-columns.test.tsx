/**
 * F119 T115 (FR-026; contracts/dashboard-and-notifications.md § 1.2 "At phone
 * width") — below `md` the card carries member, subject, stage, whose turn
 * and time in stage; round and the proposed / confirmed send times move to
 * the detail page. No horizontal scroll and no hidden-column menu: the card
 * is a stack of labelled lines, never a squeezed table.
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
  submittedAtFormatted: '20 Sep 2026, 15:00',
  ageBadge: { label: '30h waiting', variant: 'amber' },
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
    expect(card.getByText('30h waiting')).toBeInTheDocument();
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
