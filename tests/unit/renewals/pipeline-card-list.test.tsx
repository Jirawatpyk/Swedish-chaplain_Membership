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
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('review round 1 (FIX 3 / I-2, WCAG 1.3.1): labels the expires date, unlike the bare <time> the table renders', () => {
    render(<Harness rows={ROWS} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    // The card passes `columns.expires` ("Expires") as a visible label
    // preceding the <time> — the table gets its "Expires" meaning from
    // the column <th> instead (see `cycle-cells.tsx`'s `CycleExpiresCell`
    // `label` prop docstring).
    expect(within(card).getByText('Expires')).toBeInTheDocument();
  });

  it('review round 1 (FIX 2 / I-1 parity): restores status, last-reminder (—), and invoice (—) fields the card previously dropped', () => {
    render(<Harness rows={ROWS} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });

    // Status — same `admin.renewals.table.status.*` i18n keys as the
    // table's status column. The label + translated value share one <p>
    // (three text nodes: label, a space, value), so the exact combined
    // string is asserted rather than the label alone.
    expect(within(card).getByText('Status Upcoming')).toBeInTheDocument();

    // Last reminder — ROWS[0].lastReminderAt is null → em-dash sentinel,
    // same as the table's last_reminder column when null.
    expect(within(card).getByText('Last reminder —')).toBeInTheDocument();

    // Invoice — ROWS[0].linkedInvoiceId is null and anchored is false →
    // em-dash sentinel, same as the table's invoice column in that state.
    expect(within(card).getByText('Invoice —')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'View invoice' })).toBeNull();
    expect(within(card).queryByText('Covered')).toBeNull();
  });

  it('review round 1 (FIX 2 / I-1 parity): renders the "View invoice" link when linkedInvoiceId is set', () => {
    const rowsWithInvoice: ReadonlyArray<PipelineRow> = [
      { ...ROWS[0]!, linkedInvoiceId: 'inv-123' },
    ];
    render(<Harness rows={rowsWithInvoice} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    const link = within(card).getByRole('link', { name: 'View invoice' });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-123');
  });

  it('review round 1 (FIX 2 / I-1 parity): renders the "Covered" label + sr-only reason when anchored and no invoice is linked yet', () => {
    const anchoredRows: ReadonlyArray<PipelineRow> = [
      // Explicit pre-expiry countdown urgency (mirrors the desktop positive
      // test) so this "Covered"-shows case is self-documenting and does not
      // silently depend on ROWS[0]'s default bucket.
      { ...ROWS[0]!, linkedInvoiceId: null, anchored: true, urgency: 't-30' },
    ];
    render(<Harness rows={anchoredRows} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    // Text label carries the meaning (WCAG 1.4.1); the sr-only span
    // exposes the SAME reason text the table's `title` attr gives sighted
    // mouse users — same "Covered" treatment as the table's invoice cell.
    expect(within(card).getByText('Covered')).toBeInTheDocument();
    expect(
      within(card).getByText(
        /This renewal period is already covered by an earlier payment/,
      ),
    ).toBeInTheDocument();
  });

  // 059-membership-suspension covered-gate fix — an anchored cycle whose
  // covered period has ALREADY ended (urgency `suspended`/`terminated`)
  // must fall through to "—", NOT the green "Covered" label — a renewal
  // is effectively owed there, so "Covered" would be misleading.
  it('covered-gate fix: falls through to "Invoice —", NOT "Covered", when anchored but urgency is "suspended" (past-expiry)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...ROWS[0]!, linkedInvoiceId: null, anchored: true, urgency: 'suspended' },
    ];
    render(<Harness rows={rows} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    expect(within(card).queryByText('Covered')).toBeNull();
    expect(within(card).getByText('Invoice —')).toBeInTheDocument();
  });

  it('covered-gate fix: falls through to "Invoice —", NOT "Covered", when anchored but urgency is "terminated" (past-expiry)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...ROWS[0]!, linkedInvoiceId: null, anchored: true, urgency: 'terminated' },
    ];
    render(<Harness rows={rows} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    expect(within(card).queryByText('Covered')).toBeNull();
    expect(within(card).getByText('Invoice —')).toBeInTheDocument();
  });

  it('review round 1 (FIX 2 / I-1 parity): renders the last-reminder RelativeTime when lastReminderAt is set', () => {
    const remindedRows: ReadonlyArray<PipelineRow> = [
      { ...ROWS[0]!, lastReminderAt: '2020-01-01T00:00:00.000Z' },
    ];
    render(<Harness rows={remindedRows} />);
    const card = screen.getByRole('group', { name: 'Acme Co' });
    // Two <time> elements now render in the card: CycleExpiresCell's
    // (expires) and RelativeTime's (last reminder). Assert the SECOND one
    // carries the reminder's ISO instant (RelativeTime's exact rendered
    // TEXT is real-clock-dependent — "X years ago" — so we assert the
    // machine-stable `dateTime` attribute instead, same discipline as the
    // expires assertion above).
    const times = card.querySelectorAll('time');
    expect(times).toHaveLength(2);
    expect(times[1]).toHaveAttribute('dateTime', '2020-01-01T00:00:00.000Z');
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
