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
        columns: {
          company: 'Company',
          country: 'Country',
          plan: 'Plan',
          year: 'Year',
          primaryContact: 'Primary contact',
          status: 'Status',
          risk: 'Risk',
          lastActivity: 'Last activity',
          notes: 'Notes',
        },
        statusActive: 'Active',
        statusInactive: 'Inactive',
        statusArchived: 'Archived',
        riskPlaceholder: '—',
        rowAriaLabel: 'Open {company}',
        noPrimary: 'No primary',
        loadMore: 'Load more',
      },
      inlineEdit: {
        statusUpdated: 'Updated',
        saveFailed: 'Failed',
        saving: 'Saving',
        toggleStatus: 'Toggle ({current})',
        editCountry: 'Edit country',
        editCountryHint: 'Double-click to edit',
        countryUpdated: 'Country updated',
        countryInvalid: 'Invalid',
        countryInput: 'Country code',
        editNotes: 'Edit notes',
        editNotesHint: 'Double-click notes',
        notesUpdated: 'Notes updated',
        notesSaved: 'Notes saved',
        notesInput: 'Edit notes',
        notesPlaceholder: 'Add notes',
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
    member_number: 42,
    member_number_display: 'SCCM-0042',
    company_name: 'Fogmaker AB',
    country: 'SE',
    plan_id: 'plan-1',
    plan_year: 2026,
    plan_display_name: 'Premium Corporate',
    status: 'active',
    member_risk_flag: null,
    engagement: null,
    last_activity_at: '2026-04-10T00:00:00Z',
    notes: null,
    primary_contact: {
      contact_id: 'c1',
      first_name: 'Anna',
      last_name: 'A',
      email: 'anna@fog.se',
    },
  },
  {
    member_id: 'cccc-3333-dddd-4444',
    member_number: 43,
    member_number_display: 'SCCM-0043',
    company_name: 'IKEA Thailand',
    country: 'TH',
    plan_id: 'plan-2',
    plan_year: 2026,
    plan_display_name: 'Regular Corporate',
    status: 'active',
    member_risk_flag: null,
    engagement: null,
    last_activity_at: null,
    notes: null,
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
