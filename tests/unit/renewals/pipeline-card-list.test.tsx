/**
 * Task 12 — `<PipelineCardList>` mobile card-stack unit tests.
 *
 * `PipelineCardList` is handed the SAME `useReactTable` instance
 * `pipeline-table.tsx` builds for the desktop `<table>` — the harness
 * below constructs a real TanStack table with the identical config shape
 * (`getRowId: row => row.cycleId`, `enableRowSelection`,
 * `onRowSelectionChange`) so this file exercises the ACTUAL row API the
 * card list consumes (`row.getIsSelected()` / `row.toggleSelected()`),
 * not a stub. `columns: []` is deliberate — `PipelineCardList` never
 * calls `flexRender`/`row.getVisibleCells()`, it reads `row.original`
 * directly, so no column defs are needed for this harness to be faithful.
 *
 * `next/navigation` is mocked the same way as `pipeline-table.test.tsx` —
 * the reused `RowActions` calls `useRouter()` unconditionally for its
 * "Open" action's soft-nav.
 *
 * `vi.useRealTimers()` in `beforeEach` — same discipline as
 * `pipeline-table-selection.test.tsx`: the shared test setup
 * (`tests/setup.ts`) installs fake timers globally, under which
 * `@testing-library/react`'s internal `waitFor`/`findBy*` polling never
 * resolves and the test spins to the 30s timeout.
 *
 * Base UI's `Checkbox` dispatches via `PointerEvent`, which jsdom does
 * not implement — the minimal polyfill below is copied from
 * `pipeline-table-selection.test.tsx` / `members-table-selection.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  type RowSelectionState,
} from '@tanstack/react-table';
import en from '@/i18n/messages/en.json';
import { PipelineCardList } from '@/app/(staff)/admin/renewals/_components/pipeline-card-list';
import type { PipelineRow } from '@/modules/renewals/client';

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

const ROWS: ReadonlyArray<PipelineRow> = [
  {
    cycleId: 'c1' as PipelineRow['cycleId'],
    memberId: 'm1',
    companyName: 'Acme Co',
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    urgency: 't-30',
    status: 'upcoming' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  },
];

/**
 * Harness building the SAME `useReactTable` config `pipeline-table.tsx`
 * uses (minus the `columns` this list never touches) — see the module
 * docstring for why an empty `columns` array is faithful here.
 */
function Harness({
  rows,
  enableSelection = false,
}: {
  readonly rows: ReadonlyArray<PipelineRow>;
  readonly enableSelection?: boolean;
}) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Same documented React Compiler skip `pipeline-table.tsx` suppresses —
  // TanStack Table's `useReactTable()` returns helpers the compiler can't
  // safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows as PipelineRow[],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: enableSelection,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
    getRowId: (row) => row.cycleId,
  });
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineCardList
        table={table}
        canMutate
        enableSelection={enableSelection}
        onRecordOutreach={vi.fn()}
        onMarkPaid={vi.fn()}
      />
    </NextIntlClientProvider>
  );
}

describe('<PipelineCardList>', () => {
  it('renders one card per row with company, tier, urgency TEXT label, expires, and the RowActions trigger', () => {
    render(<Harness rows={ROWS} />);

    // One labeled group per cycle (brief Step 1 + a11y: each card is a
    // `role="group"` named by the company).
    const card = screen.getByRole('group', { name: 'Acme Co' });
    expect(card).toBeInTheDocument();

    // Company (CycleCompanyCell).
    expect(screen.getByRole('link', { name: 'Acme Co' })).toBeInTheDocument();
    // Tier (CycleTierCell → TierBadge).
    expect(screen.getByText('Premium')).toBeInTheDocument();
    // Urgency — a visible TEXT label, never colour alone (WCAG 1.4.1).
    expect(screen.getByText('Renews in 30d')).toBeInTheDocument();
    // Expires (CycleExpiresCell) — a <time> element carrying the ISO
    // instant (not asserting the exact locale-formatted text, which is
    // `useFormatter`'s concern and already covered where `CycleExpiresCell`
    // is unit-tested directly).
    const expiresTime = card.querySelector('time');
    expect(expiresTime).toHaveAttribute('dateTime', '2026-12-01T00:00:00.000Z');
    // RowActions' ⋯ trigger, reused unchanged.
    expect(
      screen.getByRole('button', { name: 'Actions for Acme Co' }),
    ).toBeInTheDocument();

    // Only one card renders for one row.
    expect(screen.getAllByRole('group')).toHaveLength(1);
  });

  it('does not render a selection checkbox when enableSelection is absent', () => {
    render(<Harness rows={ROWS} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders a selection checkbox when enableSelection is set, sharing the row API the table uses', () => {
    render(<Harness rows={ROWS} enableSelection />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select Acme Co' });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });

  it('falls back to the generic select-row label when companyName is empty', () => {
    const noCompanyRow: ReadonlyArray<PipelineRow> = [
      { ...ROWS[0]!, companyName: '' },
    ];
    render(<Harness rows={noCompanyRow} enableSelection />);
    expect(
      screen.getByRole('checkbox', { name: 'Select this member' }),
    ).toBeInTheDocument();
  });

  it('renders the month-lens empty-state copy (shared with the table) when rows are empty', () => {
    render(<Harness rows={[]} />);
    expect(screen.getByText('No members in this bucket.')).toBeInTheDocument();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });
});
