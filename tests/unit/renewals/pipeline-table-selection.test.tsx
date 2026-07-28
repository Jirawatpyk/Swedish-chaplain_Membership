/**
 * Task 10 — row selection in `<PipelineTable>` (US3 scaffolding).
 *
 * Mirrors `tests/unit/members/presentation/members-table-selection.test.tsx`:
 * checkboxes render only when `enableSelection` is set, and toggling a row
 * emits its `cycleId` (not `memberId` — this table's `getRowId` keys on the
 * renewal cycle, not the member) via `onSelectionChange`.
 *
 * `vi.useRealTimers()` in `beforeEach` is REQUIRED — the shared test setup
 * (`tests/setup.ts`) installs fake timers globally, under which
 * `@testing-library/react`'s internal `waitFor`/`findBy*` polling never
 * resolves and the test spins to the 30s timeout (see
 * `pipeline-table.test.tsx`'s same discipline for the finalFocus + canMutate
 * suites).
 *
 * Base UI's `Checkbox` dispatches via `PointerEvent`, which jsdom does not
 * implement — the minimal polyfill below is copied from
 * `members-table-selection.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import type { PipelineRow } from '@/modules/renewals/client';

// `RowActions` (rendered per-row regardless of `enableSelection`) calls
// `useRouter()` unconditionally for the "Open" action's soft-nav — same
// mock as `pipeline-table.test.tsx`.
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
    companyName: 'Acme',
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-08-15T17:00:00.000Z',
    urgency: 't-30',
    status: 'awaiting_payment' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: 'inv1',
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  },
];

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('<PipelineTable> row selection (Task 10 — US3 scaffolding)', () => {
  it('renders no checkbox when enableSelection is absent', () => {
    render(wrap(<PipelineTable rows={ROWS} canMutate />));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('emits the row cycleId via onSelectionChange when its checkbox is toggled', () => {
    const onSelectionChange = vi.fn();
    render(
      wrap(
        <PipelineTable
          rows={ROWS}
          canMutate
          enableSelection
          onSelectionChange={onSelectionChange}
        />,
      ),
    );

    // [0] is the header "select all" checkbox; [1] is the first row.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[1]!);

    expect(onSelectionChange).toHaveBeenLastCalledWith(['c1']);
  });
});
