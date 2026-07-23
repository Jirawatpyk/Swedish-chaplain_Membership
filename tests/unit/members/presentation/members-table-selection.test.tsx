/**
 * Unit test: MembersTable row selection logic (T108 regression).
 *
 * Verifies that:
 * 1. Checkbox click populates selectedIds with member_id (not row index)
 * 2. BulkActionBar receives correct selectedIds
 * 3. Selection state uses member_id as key (via getRowId)
 *
 * Bug caught 2026-04-16: getRowId was set to member_id but
 * handleRowSelectionChange was mapping with rows[Number(idx)] — UUID
 * strings cast to NaN, always returning undefined → empty selection.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { MembersTableRow } from '@/components/members/members-table';

// Base UI Checkbox uses PointerEvent internally; jsdom lacks it.
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

// Minimal messages for the test
// Mock sonner so toast calls don't explode in jsdom
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const messages = {
  admin: {
    members: {
      directory: {
        selectAll: 'Select all',
        selectRow: 'Select {company}',
        selectedCount: '{count} selected',
        selectAllMatchingHint: 'All {count} selected. <loadMore>Load next</loadMore>',
        tableCaption: 'Members',
        columns: {
          company: 'Company',
          plan: 'Plan',
          primaryContact: 'Primary contact',
          status: 'Status',
          lastActivity: 'Last activity',
        },
        statusActive: 'Active',
        statusInactive: 'Inactive',
        statusArchived: 'Archived',
        rowAriaLabel: 'Open {company}',
        noPrimary: 'No primary',
        loadMore: 'Load more',
      },
      inlineEdit: {
        columnHeaderHintTooltip: 'edit',
        statusUpdated: 'Updated',
        saveFailed: 'Failed',
        saving: 'Saving',
        saved: 'Saved',
        toggleStatus: 'Toggle ({current})',
        networkError: 'Network error',
      },
    },
  },
};

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

const testRows: MembersTableRow[] = [
  {
    member_id: 'aaaa-1111-bbbb-2222',
    member_number_display: 'SCCM-0042',
    company_name: 'Fogmaker AB',
    country: 'SE',
    plan_id: 'plan-1',
    plan_year: 2026,
    plan_display_name: 'Premium Corporate',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    portal_state: null,
    engagement: null,
    last_activity_at: '2026-04-10T00:00:00Z',
    primary_contact: {
      contact_id: 'c1',
      first_name: 'Anna',
      last_name: 'A',
      email: 'anna@fog.se',
    },
  },
  {
    member_id: 'cccc-3333-dddd-4444',
    member_number_display: 'SCCM-0043',
    company_name: 'IKEA Thailand',
    country: 'TH',
    plan_id: 'plan-2',
    plan_year: 2026,
    plan_display_name: 'Regular Corporate',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    portal_state: null,
    engagement: null,
    last_activity_at: null,
    primary_contact: null,
  },
];

describe('MembersTable selection (T108 regression)', () => {
  it('onSelectionChange receives member_id, not row index', async () => {
    const selectionSpy = vi.fn();

    // Dynamic import to pick up the mock
    const { MembersTable } = await import('@/components/members/members-table');

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={testRows}
          nextCursor={null}
          enableSelection={true}
          onSelectionChange={selectionSpy}
        />
      </NextIntlClientProvider>,
    );

    // Find the first row checkbox (skip header checkbox)
    const checkboxes = screen.getAllByRole('checkbox');
    // checkboxes[0] = header "Select all", checkboxes[1] = first row, checkboxes[2] = second row
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);

    // Click the first row checkbox
    fireEvent.click(checkboxes[1]!);

    // Verify onSelectionChange was called with member_id
    expect(selectionSpy).toHaveBeenCalled();
    const lastCall = selectionSpy.mock.calls[selectionSpy.mock.calls.length - 1];
    const selectedIds = lastCall?.[0] as string[];

    // The critical assertion: selectedIds should contain the actual member_id
    // NOT a row index like "0"
    expect(selectedIds).toContain('aaaa-1111-bbbb-2222');
    expect(selectedIds).not.toContain('0');
  });

  it('header checkbox selects all member_ids', async () => {
    const selectionSpy = vi.fn();

    const { MembersTable } = await import('@/components/members/members-table');

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={testRows}
          nextCursor={null}
          enableSelection={true}
          onSelectionChange={selectionSpy}
        />
      </NextIntlClientProvider>,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    // Click header "Select all"
    fireEvent.click(checkboxes[0]!);

    expect(selectionSpy).toHaveBeenCalled();
    const lastCall = selectionSpy.mock.calls[selectionSpy.mock.calls.length - 1];
    const selectedIds = lastCall?.[0] as string[];

    expect(selectedIds).toContain('aaaa-1111-bbbb-2222');
    expect(selectedIds).toContain('cccc-3333-dddd-4444');
    expect(selectedIds).toHaveLength(2);
  });

  // BUG-013 follow-up (code-review): once archived rows became non-selectable,
  // the "Select all N matching" banner must key off the table's own
  // all-page-selected state, NOT `selectedCount === rows.length` (which can
  // never hold on a page mixing archived + active rows). Regression guard.
  it('shows the cross-page "select all matching" banner on a mixed archived page when every selectable row is chosen', async () => {
    const { MembersTable } = await import('@/components/members/members-table');

    // 1 active (selectable) + 1 archived (non-selectable); a next cursor makes
    // the cross-page banner eligible.
    const mixedRows: MembersTableRow[] = [
      testRows[0]!,
      { ...testRows[1]!, member_id: 'eeee-5555-ffff-6666', status: 'archived' },
    ];

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={mixedRows}
          nextCursor="cursor-xyz"
          enableSelection={true}
          onSelectionChange={vi.fn()}
        />
      </NextIntlClientProvider>,
    );

    // No banner before any selection.
    expect(screen.queryByRole('button', { name: 'Load next' })).toBeNull();

    // Select-all on the page: only the active row is selectable, so
    // selectedCount (1) < rows.length (2). The banner must STILL appear.
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    expect(screen.getByRole('button', { name: 'Load next' })).toBeTruthy();
  });

  it('no checkboxes when enableSelection is false', async () => {
    const { MembersTable } = await import('@/components/members/members-table');

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={testRows}
          nextCursor={null}
          enableSelection={false}
        />
      </NextIntlClientProvider>,
    );

    const checkboxes = screen.queryAllByRole('checkbox');
    expect(checkboxes).toHaveLength(0);
  });
});

describe('MembersTable inline-edit rendering (round-2 review I-6)', () => {
  it('renders InlineStatusCell button when enableSelection + onInlineEdit provided (admin)', async () => {
    const { MembersTable } = await import('@/components/members/members-table');
    const successSave = vi.fn().mockResolvedValue({ ok: true });

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={testRows}
          nextCursor={null}
          enableSelection={true}
          onInlineEdit={successSave}
        />
      </NextIntlClientProvider>,
    );

    // Admin sees toggleable status buttons
    const statusButtons = screen.getAllByRole('button', { name: /Toggle/ });
    expect(statusButtons.length).toBeGreaterThan(0);
  });

  it('does NOT render InlineStatusCell when onInlineEdit is undefined (manager read-only)', async () => {
    const { MembersTable } = await import('@/components/members/members-table');

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={testRows}
          nextCursor={null}
          enableSelection={true}
          // onInlineEdit intentionally undefined — manager read-only path
        />
      </NextIntlClientProvider>,
    );

    // Manager sees status badge (no button)
    const statusButtons = screen.queryAllByRole('button', { name: /Toggle/ });
    expect(statusButtons).toHaveLength(0);
  });
});
