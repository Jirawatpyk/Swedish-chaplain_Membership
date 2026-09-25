// @vitest-environment jsdom
/**
 * PR-2 leftover (#400 small item 11) — the members bulk bar's Clear.
 *
 * Clear empties the selection, so the bar returns null and the focused Clear
 * button goes with it: focus fell to `<body>` and a keyboard user had to Tab
 * back from the top. It now hands focus to the table's select-all checkbox —
 * which survives the clear — and, where that is not focusable (below `md` the
 * table is hidden), to the `#main-content` landmark. The E-Blast queue's bulk
 * bar has done this since T086a V2 (`queue-bulk-action-bar.tsx`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';
import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));

const CLEAR = enMessages.admin.members.bulk.clear;
const SELECT_ALL = 'members-select-all';

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

function bar(onClear: () => void) {
  return (
    <BulkActionBar
      selectedIds={['11111111-2222-3333-4444-555555555555']}
      selectedCompanyNames={['Acme Co']}
      totalMatching={1}
      onClear={onClear}
    />
  );
}

describe('members bulk bar — Clear keeps keyboard focus on the page', () => {
  it('the directory table\'s select-all checkbox carries the id the bar looks for', () => {
    const row = {
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
      last_activity_at: null,
      primary_contact: null,
    } as MembersTableRow;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MembersTable rows={[row]} enableSelection onSelectionChange={vi.fn()} />
      </NextIntlClientProvider>,
    );
    const selectAll = screen.getByTestId(SELECT_ALL);
    expect(selectAll).toHaveAccessibleName(enMessages.admin.members.directory.selectAll);
    // The id sits on the FOCUSABLE element (Base UI forwards it to the control).
    selectAll.focus();
    expect(selectAll).toHaveFocus();
  });

  it('Clear hands focus to the select-all checkbox, then clears', () => {
    const onClear = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <main id="main-content" tabIndex={-1}>
          <input type="checkbox" data-testid={SELECT_ALL} aria-label="Select all" />
          {bar(onClear)}
        </main>
      </NextIntlClientProvider>,
    );
    const clear = screen.getByRole('button', { name: CLEAR });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.getByTestId(SELECT_ALL)).toHaveFocus();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('with no focusable select-all (the table is hidden below md), focus goes to #main-content', () => {
    const onClear = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <main id="main-content" tabIndex={-1}>{bar(onClear)}</main>
      </NextIntlClientProvider>,
    );
    const clear = screen.getByRole('button', { name: CLEAR });
    clear.focus();
    fireEvent.click(clear);
    expect(document.getElementById('main-content')).toHaveFocus();
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
