/**
 * 122 US5a (T504) — the members bulk bar is AURA `ActionBar`.
 *
 * It replaces the fixed full-width bar and its measured spacer: the ActionBar
 * is sticky and sits in the page flow after the table, so it floats over the
 * list while the table is on screen and can never cover the last row or the
 * pagination (it takes its own space in the flow). It stays mounted with
 * nothing selected — hidden, but with its live region in place, so the next
 * selection is announced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

const BULK = enMessages.admin.members.bulk;

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBar(selectedIds: string[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkActionBar
        selectedIds={selectedIds}
        selectedCompanyNames={selectedIds.map((_, i) => `Company ${i + 1}`)}
        totalMatching={selectedIds.length}
        onClear={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe('BulkActionBar on AURA ActionBar (T504)', () => {
  it('is the AURA ActionBar region, named, with the count and every action', () => {
    renderBar(['11111111-2222-3333-4444-555555555555', '21111111-2222-3333-4444-555555555555']);
    const region = screen.getByRole('region', { name: BULK.toolbarLabel });
    expect(region).toHaveClass('aura-actionbar');
    expect(region).not.toHaveClass('is-idle');
    expect(region).toHaveTextContent('2 selected');
    for (const action of [
      BULK.actions.archive,
      BULK.actions.send_portal_invite,
      BULK.actions.enrol_auto_invoice,
      BULK.actions.unenrol_auto_invoice,
      BULK.actions.send_renewal_reminder,
      BULK.clear,
    ]) {
      expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    }
  });

  it('every control in the bar, Clear included, is a 44px touch target (WCAG 2.5.5)', () => {
    renderBar(['11111111-2222-3333-4444-555555555555']);
    const buttons = within(screen.getByRole('region', { name: BULK.toolbarLabel })).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(BULK.clear);
    for (const button of buttons) expect(button).toHaveClass('aura-btn--touch');
  });

  it('renders no spacer: the bar is in the flow, not fixed over the page', () => {
    const { container } = renderBar(['11111111-2222-3333-4444-555555555555']);
    const spacers = Array.from(
      container.querySelectorAll<HTMLElement>('div[aria-hidden="true"]'),
    ).filter((el) => el.style.height !== '');
    expect(spacers).toHaveLength(0);
    expect(screen.getByRole('region', { name: BULK.toolbarLabel }).className).not.toMatch(/\bfixed\b/);
  });

  it('stays mounted, idle and without actions, when nothing is selected', () => {
    renderBar([]);
    const region = screen.getByRole('region', { name: BULK.toolbarLabel });
    expect(region).toHaveClass('is-idle');
    expect(screen.queryByRole('button', { name: BULK.actions.archive })).toBeNull();
    expect(screen.queryByRole('button', { name: BULK.clear })).toBeNull();
  });
});
