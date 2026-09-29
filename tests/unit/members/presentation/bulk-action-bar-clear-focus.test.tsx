// @vitest-environment jsdom
/**
 * PR-2 leftover (#400 small item 11) — the members bulk bar's Clear.
 *
 * Clear empties the selection, so the bar's buttons go away with it and the
 * focused Clear button used to drop focus to `<body>`. AURA's ActionBar
 * (122 US5a, T504) returns focus to where it came from when it can; when it
 * cannot, the bar hands focus to the members table's select-all header cell
 * — it survives the clear, and it is a grid cell, so the arrow keys work from
 * there — and otherwise to the `#main-content` landmark.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';
import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';
import { DirectoryWithBulk } from '@/app/(staff)/admin/members/_components/directory-with-bulk';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));
vi.mock('@/components/layout/table-pagination', () => ({ TablePagination: () => null }));

const CLEAR = enMessages.admin.members.bulk.clear;
const SELECT_ALL = enMessages.admin.members.directory.selectAll;

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI dispatches these)
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(t: string, params?: PointerEventInit) {
        super(t, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A real stateful parent: Clear genuinely empties the selection. */
function Bar({ onClear }: { onClear: () => void }) {
  const [ids, setIds] = useState(['11111111-2222-3333-4444-555555555555']);
  return (
    <BulkActionBar
      selectedIds={ids}
      selectedCompanyNames={['Acme Co']}
      totalMatching={1}
      onClear={() => {
        onClear();
        setIds([]);
      }}
    />
  );
}

describe('members bulk bar — Clear keeps keyboard focus on the page', () => {
  const base = {
    member_number_display: 'SCCM-0042',
    country: 'SE',
    plan_id: 'plan-1',
    plan_year: 2026,
    plan_display_name: 'Premium Corporate',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    portal_state: null,
    engagement: null,
    last_activity_at: null,
    primary_contact: null,
  } as const;
  const rows = [
    { ...base, member_id: 'aaaa-1111', company_name: 'Fogmaker AB' },
    { ...base, member_id: 'bbbb-2222', company_name: 'Volvo AB' },
  ] as unknown as MembersTableRow[];

  it('the members table\'s select-all checkbox is named and focusable', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MembersTable rows={rows} enableSelection onSelectionChange={vi.fn()} />
      </NextIntlClientProvider>,
    );
    const grid = screen.getByRole('grid');
    const selectAll = within(grid).getByRole('checkbox', { name: SELECT_ALL });
    selectAll.focus();
    expect(selectAll).toHaveFocus();
  });

  it('in the REAL directory composition, Clear leaves focus on the select-all header cell', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <main id="main-content" tabIndex={-1}>
          <DirectoryWithBulk rows={rows} page={1} pageSize={50} total={2} isAdmin />
        </main>
      </NextIntlClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: enMessages.admin.members.directory.selectRow.replace('{company}', 'Fogmaker AB'),
      }),
    );
    const clear = screen.getByRole('button', { name: CLEAR });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole('button', { name: CLEAR })).toBeNull();
    await waitFor(() => {
      const selectAllCell = within(screen.getByRole('grid')).getAllByRole('columnheader')[0];
      expect(selectAllCell).toHaveAttribute('data-rc', '0:0');
      expect(selectAllCell).toHaveFocus();
    });
  });

  it('with no members table on the page, focus goes to #main-content', async () => {
    const onClear = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <main id="main-content" tabIndex={-1}><Bar onClear={onClear} /></main>
      </NextIntlClientProvider>,
    );
    const clear = screen.getByRole('button', { name: CLEAR });
    clear.focus();
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.getElementById('main-content')).toHaveFocus());
  });
});
