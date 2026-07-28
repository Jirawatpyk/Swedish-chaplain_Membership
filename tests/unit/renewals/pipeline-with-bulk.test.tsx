/**
 * Task 10 — `<PipelineWithBulk>` wrapper component test.
 *
 * `PipelineWithBulk` is a pass-through wrapper around `<PipelineTable>`:
 * it forwards `sort`/`sortHrefs`/`resultCount`/`monthKind`/`monthLabel`
 * unchanged, and additionally derives `canMutate`/`enableSelection` from
 * `isAdmin` plus owns the row-selection state (reset on a fresh `rows`
 * reference — the "adjust state during render" pattern copied from
 * `directory-with-bulk.tsx`). The bulk action bar itself is stubbed `null`
 * this task (Task 11 mounts the real `PipelineBulkActionBar`), so this test
 * only exercises the selection wiring + prop forwarding, not a bulk bar.
 *
 * `vi.useRealTimers()` in `beforeEach` — same discipline as
 * `pipeline-table-selection.test.tsx`: the shared test setup
 * (`tests/setup.ts`) installs fake timers globally.
 *
 * Base UI's `Checkbox` dispatches via `PointerEvent`, which jsdom does not
 * implement — the minimal polyfill below is copied from
 * `members-table-selection.test.tsx` / `pipeline-table-selection.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineWithBulk } from '@/app/(staff)/admin/renewals/_components/pipeline-with-bulk';
import type { PipelineRow } from '@/modules/renewals/client';

// `RowActions` (rendered per-row inside `PipelineTable`) calls `useRouter()`
// unconditionally for the "Open" action's soft-nav.
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

function row(cycleId: string, companyName: string): PipelineRow {
  return {
    cycleId: cycleId as PipelineRow['cycleId'],
    memberId: `mem-${cycleId}`,
    companyName,
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
  };
}

const ROWS: ReadonlyArray<PipelineRow> = [row('c1', 'Acme')];

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('<PipelineWithBulk> (Task 10 — US3 scaffolding)', () => {
  it('admin: enables selection checkboxes on the underlying PipelineTable', () => {
    render(wrap(<PipelineWithBulk rows={ROWS} isAdmin />));
    // header select-all + one row checkbox.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('manager (isAdmin=false): no selection checkboxes render', () => {
    render(wrap(<PipelineWithBulk rows={ROWS} isAdmin={false} />));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('manager (isAdmin=false): mutation affordances stay hidden (canMutate threaded through)', () => {
    render(wrap(<PipelineWithBulk rows={ROWS} isAdmin={false} />));
    expect(
      screen.queryByRole('button', { name: /send reminder/i }),
    ).toBeNull();
  });

  it('forwards resultCount unchanged, rendered above the table rows', () => {
    render(
      wrap(
        <PipelineWithBulk
          rows={ROWS}
          isAdmin
          resultCount={<p data-testid="result-count">Showing 1 member</p>}
        />,
      ),
    );
    expect(screen.getByTestId('result-count')).toHaveTextContent(
      'Showing 1 member',
    );
  });

  it('forwards sort + sortHrefs unchanged to PipelineTable\'s sortable headers (review-fix test hardening)', () => {
    // Guards against a future dropped `sort`/`sortHrefs` prop silently
    // degrading the pipeline headers back to plain text (no sort link, no
    // `aria-sort`) — the brief flagged this exact regression class.
    render(
      wrap(
        <PipelineWithBulk
          rows={ROWS}
          isAdmin
          sort="tier_asc"
          sortHrefs={{
            expires: '/admin/renewals?sort=expires_at_asc',
            tier: '/admin/renewals?sort=tier_desc',
          }}
        />,
      ),
    );

    const tierSortLink = screen.getByRole('link', { name: 'Sort by Tier' });
    expect(tierSortLink).toHaveAttribute(
      'href',
      '/admin/renewals?sort=tier_desc',
    );
    // `aria-sort` lives on the enclosing `<th>` (columnheader), not the link
    // itself — WCAG 1.3.1 / 4.1.2 (see `pipeline-table.tsx`'s own rationale).
    expect(tierSortLink.closest('th')).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('forwards monthKind + monthLabel unchanged to PipelineTable\'s empty-state copy', () => {
    render(
      wrap(
        <PipelineWithBulk
          rows={[]}
          isAdmin
          monthKind="later"
          monthLabel="August 2028"
        />,
      ),
    );
    expect(
      screen.getByText('No members renew August 2028 or later.'),
    ).toBeInTheDocument();
  });

  it('resets the selection when a fresh rows reference arrives (server re-render)', () => {
    const { rerender } = render(wrap(<PipelineWithBulk rows={ROWS} isAdmin />));

    const rowCheckbox = screen.getAllByRole('checkbox')[1]!;
    fireEvent.click(rowCheckbox);
    expect(rowCheckbox).toHaveAttribute('aria-checked', 'true');

    // A NEW array reference (same or different content) simulates the page
    // re-rendering after a router.refresh() / filter change — the "adjust
    // state during render" reset must drop the stale selection to zero.
    const freshRows: ReadonlyArray<PipelineRow> = [row('c1', 'Acme')];
    rerender(wrap(<PipelineWithBulk rows={freshRows} isAdmin />));

    const rowCheckboxAfter = screen.getAllByRole('checkbox')[1]!;
    expect(rowCheckboxAfter).toHaveAttribute('aria-checked', 'false');
  });
});
