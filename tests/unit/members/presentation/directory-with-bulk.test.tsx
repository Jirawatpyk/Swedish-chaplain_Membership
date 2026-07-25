/**
 * DirectoryWithBulk selection orchestration (bulk-feature review fixes):
 *   #1 — a manual checkbox change EXITS the cross-page "select all matching"
 *        set, so a just-unchecked row is no longer in the bulk target.
 *   #2 — a fresh `rows` prop (filter/page change) resets the WHOLE selection,
 *        so a selection made under one filter never acts on now-hidden members.
 *
 * MembersTable + BulkActionBar + TablePagination are replaced with stand-ins:
 * the MembersTable stub exposes the selection callbacks as buttons + echoes
 * `matchingActive`/`matchingCount`; the BulkActionBar stub echoes the effective
 * `selectedIds` it would act on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { MembersTableRow } from '@/components/members/members-table';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/layout/table-pagination', () => ({ TablePagination: () => null }));

vi.mock('@/components/members/members-table', () => ({
  MembersTable: ({
    onSelectionChange,
    onSelectAllMatching,
    matchingActive,
    matchingCount,
  }: {
    onSelectionChange?: (ids: string[]) => void;
    onSelectAllMatching?: () => void;
    matchingActive?: boolean;
    matchingCount?: number;
  }) => (
    <div>
      <button data-testid="select-page" onClick={() => onSelectionChange?.(['m1', 'm2', 'm3'])}>
        page
      </button>
      <button data-testid="select-fewer" onClick={() => onSelectionChange?.(['m1', 'm2'])}>
        fewer
      </button>
      <button data-testid="select-all-matching" onClick={() => onSelectAllMatching?.()}>
        all matching
      </button>
      <div data-testid="matching-active">{String(matchingActive)}</div>
      <div data-testid="matching-count">{matchingCount ?? ''}</div>
    </div>
  ),
}));

vi.mock('@/app/(staff)/admin/members/_components/bulk-action-bar', () => ({
  BulkActionBar: ({ selectedIds }: { selectedIds: string[] }) => (
    <div data-testid="bulk-selected">{selectedIds.join(',')}</div>
  ),
}));

import { DirectoryWithBulk } from '@/app/(staff)/admin/members/_components/directory-with-bulk';
import messages from '@/i18n/messages/en.json';

const MATCHING_IDS = Array.from({ length: 100 }, (_, i) => `x${i}`);

function makeRows(ids: string[]): MembersTableRow[] {
  return ids.map(
    (id) => ({ member_id: id, company_name: id }) as unknown as MembersTableRow,
  );
}

function renderDir(rows: MembersTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectoryWithBulk rows={rows} page={1} pageSize={50} total={100} isAdmin />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // A shared setup enables fake timers, which freezes `waitFor` (30s hang) —
  // same fix as inline-status-undo.test.tsx.
  vi.useRealTimers();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ids: MATCHING_IDS, total: 100, capped: false }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('DirectoryWithBulk selection orchestration', () => {
  it('#1 — a manual selection change drops the cross-page matching set', async () => {
    renderDir(makeRows(['m1', 'm2', 'm3']));

    fireEvent.click(screen.getByTestId('select-page'));
    fireEvent.click(screen.getByTestId('select-all-matching'));

    // matching set active → the bulk target is the fetched 100.
    await waitFor(() =>
      expect(screen.getByTestId('matching-active')).toHaveTextContent('true'),
    );
    expect(screen.getByTestId('bulk-selected')).toHaveTextContent('x0,x1');

    // Uncheck a row (manual change) → matching drops, back to the page set.
    fireEvent.click(screen.getByTestId('select-fewer'));
    expect(screen.getByTestId('matching-active')).toHaveTextContent('false');
    expect(screen.getByTestId('bulk-selected').textContent).toBe('m1,m2');
  });

  it('#2 — a new rows prop (filter/page change) resets the whole selection', async () => {
    const { rerender } = renderDir(makeRows(['m1', 'm2', 'm3']));

    fireEvent.click(screen.getByTestId('select-page'));
    fireEvent.click(screen.getByTestId('select-all-matching'));
    await waitFor(() =>
      expect(screen.getByTestId('matching-active')).toHaveTextContent('true'),
    );

    // A filter/page change hands DirectoryWithBulk a fresh rows array.
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DirectoryWithBulk
          rows={makeRows(['n1', 'n2'])}
          page={2}
          pageSize={50}
          total={100}
          isAdmin
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByTestId('matching-active')).toHaveTextContent('false');
    expect(screen.getByTestId('bulk-selected').textContent).toBe('');
  });
});
