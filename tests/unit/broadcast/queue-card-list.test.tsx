/**
 * Task 4 (2026-08-01-broadcast-review-queue-pr2) — `<QueueCardList>` mobile
 * card-stack unit tests.
 *
 * `QueueCardList` is handed the SAME `useReactTable` instance
 * `queue-table-client.tsx` builds for the desktop `<table>` — the harness
 * below constructs a real TanStack table with the identical config shape
 * (`getRowId: row => row.broadcastId`, `enableRowSelection`,
 * `onRowSelectionChange`) so this file exercises the ACTUAL row API the
 * card list consumes (`row.getIsSelected()` / `row.toggleSelected()`), not
 * a stub. `columns: []` is deliberate — `QueueCardList` never calls
 * `flexRender`/`row.getVisibleCells()`, it reads `row.original` directly,
 * so no column defs are needed for this harness to be faithful. Precedent:
 * `tests/unit/renewals/pipeline-card-list.test.tsx`.
 *
 * `next/navigation` is mocked — the reused `ReviewActions` mounts
 * `ApproveDialog`/`RejectDialog` (closed) which call `useRouter()`
 * unconditionally.
 *
 * `vi.useRealTimers()` in `beforeEach` — shared test setup installs fake
 * timers globally, under which `fireEvent`-driven state updates can spin
 * `@testing-library/react` internals to the 30s test timeout. Precedent:
 * reference_component_test_harness_fake_timers memory.
 *
 * Base UI's `Checkbox` dispatches via `PointerEvent`, which jsdom does not
 * implement — minimal polyfill copied from `pipeline-card-list.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  type RowSelectionState,
} from '@tanstack/react-table';
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

const COLUMN_LABELS = { select: 'Select broadcast' };

function makeRow(overrides: Partial<EnrichedQueueRow> = {}): EnrichedQueueRow {
  return {
    broadcastId: 'b1',
    subject: 'Q3 Newsletter',
    memberDisplayName: 'Acme Co',
    actorRoleLabel: null,
    segmentLabel: 'All members',
    recipientCount: 42,
    submittedAtFormatted: '1 Aug 2026, 07:00',
    ageBadge: null,
    statusBadgeVariant: 'secondary',
    statusBadgeLabel: 'Awaiting review',
    actionable: true,
    ...overrides,
  };
}

/**
 * Harness building the SAME `useReactTable` config `queue-table-client.tsx`
 * uses (minus `columns`, which this list never touches — see the module
 * docstring for why an empty `columns` array is faithful here).
 */
function Harness({
  rows,
  readOnly = false,
}: {
  readonly rows: ReadonlyArray<EnrichedQueueRow>;
  readonly readOnly?: boolean;
}) {
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
      <QueueCardList table={table} readOnly={readOnly} columnLabels={COLUMN_LABELS} />
    </NextIntlClientProvider>
  );
}

describe('<QueueCardList>', () => {
  it('renders one card per row with the subject and the labelled Audience/Recipients fields', () => {
    render(<Harness rows={[makeRow({ broadcastId: 'b1', subject: 'Q3 Newsletter' })]} />);

    const list = screen.getByTestId('queue-card-list');
    expect(within(list).getByText('Q3 Newsletter')).toBeInTheDocument();
    expect(within(list).getByText(/Audience/)).toBeInTheDocument();
    expect(within(list).getByText(/Recipients/)).toBeInTheDocument();
    // Fix round 1 (Important, desktop/mobile parity) — WHO submitted the
    // broadcast must be visible on the card, mirroring the desktop
    // `member` column. `makeRow()` defaults `actorRoleLabel` to null, so
    // just the bare member name renders (no " · role" suffix).
    expect(within(list).getByText('Acme Co')).toBeInTheDocument();

    expect(within(list).getAllByRole('group')).toHaveLength(1);
  });

  it('renders the member name with the actor role suffix when set', () => {
    render(
      <Harness
        rows={[makeRow({ memberDisplayName: 'Bob Lee', actorRoleLabel: 'Manager' })]}
      />,
    );
    expect(screen.getByText('Bob Lee · Manager')).toBeInTheDocument();
  });

  it('renders one role="group" card per row for multiple rows', () => {
    render(
      <Harness
        rows={[
          makeRow({ broadcastId: 'b1', subject: 'First' }),
          makeRow({ broadcastId: 'b2', subject: 'Second' }),
        ]}
      />,
    );
    const list = screen.getByTestId('queue-card-list');
    expect(within(list).getAllByRole('group')).toHaveLength(2);
    expect(within(list).getByText('First')).toBeInTheDocument();
    expect(within(list).getByText('Second')).toBeInTheDocument();
  });

  it('renders the subject as a link to the broadcast detail page', () => {
    render(<Harness rows={[makeRow({ broadcastId: 'b7', subject: 'Hello' })]} />);
    const link = screen.getByRole('link', { name: 'Hello' });
    expect(link).toHaveAttribute('href', '/admin/broadcasts/b7');
  });

  it('renders the Submitted field value and the status badge label', () => {
    render(
      <Harness
        rows={[makeRow({ submittedAtFormatted: '1 Aug 2026, 07:00', statusBadgeLabel: 'Awaiting review' })]}
      />,
    );
    const list = screen.getByTestId('queue-card-list');
    expect(within(list).getByText(/Submitted/)).toBeInTheDocument();
    expect(within(list).getByText('1 Aug 2026, 07:00')).toBeInTheDocument();
    expect(within(list).getByText('Awaiting review')).toBeInTheDocument();
  });

  it('renders the age badge label when present', () => {
    render(
      <Harness
        rows={[
          makeRow({
            ageBadge: { label: 'Waiting 30h', variant: 'amber' },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Waiting 30h')).toBeInTheDocument();
  });

  it('renders the select checkbox for an actionable row when not read-only, wired to the shared row API', () => {
    render(<Harness rows={[makeRow({ actionable: true })]} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select broadcast' });
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
  });

  // Fix round 1 (Minor) — behavioral, not just initial-state: clicking the
  // card's checkbox must flip `row.toggleSelected()` on the SAME TanStack
  // row the table would see — the one property this whole task guarantees.
  // The harness's real `useReactTable` (with `state.rowSelection` +
  // `onRowSelectionChange`) round-trips this exactly as `queue-table-
  // client.tsx`'s own selection column does.
  it('toggles the shared row selection state when the checkbox is clicked', () => {
    render(<Harness rows={[makeRow({ broadcastId: 'b1', actionable: true })]} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select broadcast' });
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(checkbox);

    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    // The card's `data-state="selected"` styling hook (Card root) also
    // flips, confirming the row API — not just the checkbox's own local
    // visual state — drove the change.
    expect(screen.getByRole('group')).toHaveAttribute('data-state', 'selected');
  });

  it('does not render a select checkbox when readOnly is true', () => {
    render(<Harness rows={[makeRow({ actionable: true })]} readOnly />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('does not render a select checkbox for a non-actionable row', () => {
    render(<Harness rows={[makeRow({ actionable: false })]} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders ReviewActions (Approve/Reject) for an actionable row when not read-only', () => {
    render(<Harness rows={[makeRow({ actionable: true })]} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('does not render ReviewActions when read-only', () => {
    render(<Harness rows={[makeRow({ actionable: true })]} readOnly />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('does not render ReviewActions for a non-actionable row', () => {
    render(<Harness rows={[makeRow({ actionable: false })]} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('forwards className to the root element', () => {
    function ClassNameHarness() {
      // eslint-disable-next-line react-hooks/incompatible-library
      const table = useReactTable({
        data: [makeRow()],
        columns: [],
        getCoreRowModel: getCoreRowModel(),
        enableRowSelection: (r) => r.original.actionable,
        getRowId: (r) => r.broadcastId,
      });
      return (
        <QueueCardList
          table={table}
          readOnly={false}
          columnLabels={COLUMN_LABELS}
          className="md:hidden"
        />
      );
    }
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ClassNameHarness />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('queue-card-list')).toHaveClass('md:hidden');
  });
});
