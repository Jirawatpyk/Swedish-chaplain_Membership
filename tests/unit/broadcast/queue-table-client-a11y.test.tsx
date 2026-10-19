/**
 * The review queue's desktop list on AURA `DataTable` (spec 122 US12b): the
 * selection column follows the FR-011 rule — only `submitted` rows
 * (`actionable`) carry a checkbox; every other row's cell is named for why it
 * cannot be picked (`isRowSelectable` + `rowSelectDisabledLabel`). Select-all
 * picks the actionable rows only. A read-only (manager) view has no selection.
 *
 * Round-2 review Fix 1 — the announcer stays mounted across the
 * 0-selected ↔ 1-selected transition: a live region INSERTED with its text
 * already in it is not reliably announced by NVDA/JAWS; only text MUTATIONS
 * on a mounted region are.
 *
 * Renders under a real `NextIntlClientProvider` backed by `en.json` — an echo
 * translator would hide an ICU wiring regression.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  QueueTableClient,
  type EnrichedQueueRow,
} from '@/components/broadcast/admin/queue-table-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const base: EnrichedQueueRow = {
  broadcastId: 'b1',
  subject: 'Hi',
  memberDisplayName: 'Acme',
  actorRoleLabel: null,
  segmentLabel: 'All members',
  recipientCount: 5,
  ageBadge: null,
  statusTone: 'progress',
  statusBadgeLabel: 'Submitted',
  actionable: true,
  whoseTurnLabel: 'Marketing',
  timeInStageLabel: '3 h',
  round: 0,
  proposedSendAtFormatted: null,
  confirmedSendAtFormatted: null,
  lastActivityFormatted: '1 Aug 2026, 07:00',
  deliverySummary: null,
};
const rows: EnrichedQueueRow[] = [
  base,
  { ...base, broadcastId: 'b2', subject: 'Hi2' },
  { ...base, broadcastId: 'b3', subject: 'Closed one', actionable: false, statusTone: 'ready', statusBadgeLabel: 'Sent' },
];
const columnLabels = {
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

function renderTable(props: Partial<React.ComponentProps<typeof QueueTableClient>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueTableClient rows={rows} columnLabels={columnLabels} {...props} />
    </NextIntlClientProvider>,
  );
}

// Shared setup installs fake timers; user-event's internal delays would
// never resolve under them.
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(cleanup);

describe('QueueTableClient on AURA DataTable — selection, a11y, ICU', () => {
  it('is an AURA grid named by the table label, one row per broadcast', () => {
    renderTable();
    const grid = screen.getByRole('grid', { name: 'Broadcast review queue' });
    // header row + one row per broadcast; no virtualisation padding rows
    expect(within(grid).getAllByRole('row')).toHaveLength(rows.length + 1);
  });

  it('only actionable rows carry a checkbox, named for the subject; the others say why not', () => {
    renderTable();
    const grid = screen.getByRole('grid');
    expect(within(grid).getByRole('checkbox', { name: 'Select Hi' })).toBeInTheDocument();
    expect(within(grid).getByRole('checkbox', { name: 'Select Hi2' })).toBeInTheDocument();
    expect(within(grid).queryByRole('checkbox', { name: 'Select Closed one' })).toBeNull();
    expect(within(grid).getByRole('gridcell', { name: 'Closed one is not awaiting review' })).toBeInTheDocument();
  });

  it('the selected-count announcer is permanently mounted and announces the 0→1 transition via ICU', async () => {
    const user = userEvent.setup();
    renderTable();
    const announcer = screen.getByTestId('queue-selection-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveTextContent('');

    await user.click(screen.getByRole('checkbox', { name: 'Select Hi' }));

    expect(screen.getByTestId('queue-selection-announcer')).toBe(announcer);
    expect(announcer).toHaveTextContent(/1 selected/);
  });

  it('select-all picks only the actionable rows', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderTable({ onSelectionChange });
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByTestId('queue-selection-announcer')).toHaveTextContent(/2 selected/);
    expect(onSelectionChange).toHaveBeenLastCalledWith(['b1', 'b2']);
  });

  it('a read-only (manager) view has no selection column and no review actions', () => {
    renderTable({ readOnly: true });
    const grid = screen.getByRole('grid');
    expect(within(grid).queryByRole('checkbox')).toBeNull();
    expect(within(grid).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('marks the column the order follows with aria-sort: AURA `sortDirection` (#157)', () => {
    const { rerender } = renderTable();
    const header = (name: string) => screen.getByRole('columnheader', { name });
    expect(header('Time in stage')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Send time')).not.toHaveAttribute('aria-sort');

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QueueTableClient rows={rows} columnLabels={columnLabels} order="send_time" />
      </NextIntlClientProvider>,
    );
    expect(header('Send time')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Time in stage')).not.toHaveAttribute('aria-sort');
  });

  // AURA 5.51 #161 (`keyboard="tab"`): Approve, Reject and the row links are
  // Tab stops, not cells reached only with the arrows.
  it('every row action is a Tab stop (AURA keyboard="tab", #161)', () => {
    renderTable();
    const grid = screen.getByRole('grid');
    for (const button of within(grid).getAllByRole('button', { name: /approve|reject/i })) {
      expect(button).not.toHaveAttribute('tabindex', '-1');
    }
    for (const link of within(grid).getAllByRole('link')) expect(link).not.toHaveAttribute('tabindex', '-1');
  });

  it('wraps a long subject instead of forcing the row wider', () => {
    const longSubject = 'A'.repeat(60) + ' ' + 'B'.repeat(60) + ' very long broadcast subject line';
    renderTable({ rows: [{ ...base, subject: longSubject }] });
    const link = within(screen.getByRole('grid')).getByRole('link', { name: longSubject });
    expect(link).toHaveClass('[overflow-wrap:anywhere]');
  });
});
