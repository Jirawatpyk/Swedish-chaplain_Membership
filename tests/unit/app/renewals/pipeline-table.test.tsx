/**
 * Task 11 — `<PipelineTable>` month-lens empty-state unit tests.
 *
 * Only exercises the empty-rows branch (`rows={[]}`) since that is
 * the only path touched by the `monthLabel` prop — non-empty rows
 * render `RowActions` (router + toast wiring) which is exercised
 * elsewhere and is unaffected by this change.
 *
 * Task 1 (item ②) adds a non-empty-row suite below pinning the
 * visible "Send reminder" row button (promoted out of the ⋯ menu).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const EMPTY_ROWS: ReadonlyArray<PipelineRow> = [];

describe('<PipelineTable> empty state', () => {
  it('renders the month-aware empty copy when monthLabel is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} monthLabel="December 2026" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No members renew in December 2026.')).toBeDefined();
  });

  it('renders the default bucket empty copy when monthLabel is absent', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No members in this bucket.')).toBeDefined();
    expect(screen.getByText(/Switch to another urgency tab/)).toBeDefined();
  });

  // Deferred fix-wave-2 #4 — dedicated overdue/later empty copy. The bug
  // being pinned: the pre-fix code composed the bucket label into the
  // generic "No members renew in {month}." frame, yielding
  // "No members renew in Overdue." / a doubled "…or later or later".
  it('renders dedicated overdue empty copy when monthKind="overdue"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} monthKind="overdue" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No overdue renewals.')).toBeDefined();
  });

  it('renders dedicated later empty copy with a SINGLE "or later" when monthKind="later"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable
          rows={EMPTY_ROWS}
          monthKind="later"
          monthLabel="August 2028"
        />
      </NextIntlClientProvider>,
    );
    // Exact string — proves the copy is NOT doubled
    // ("…August 2028 or later or later").
    expect(
      screen.getByText('No members renew August 2028 or later.'),
    ).toBeDefined();
    expect(screen.queryByText(/or later or later/)).toBeNull();
  });
});

const ONE_ROW: ReadonlyArray<PipelineRow> = [
  {
    cycleId: 'cyc-1' as PipelineRow['cycleId'],
    memberId: 'mem-1',
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

describe('<PipelineTable> row actions (item ②)', () => {
  it('renders a VISIBLE "Send reminder" button per row and POSTs to send-reminder-now on click', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ outcome: { kind: 'sent' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const btn = screen.getByRole('button', { name: 'Send reminder to Acme Co' });
    fireEvent.click(btn);
    // startTransition schedules the async fetch on a microtask.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/renewals/cyc-1/send-reminder-now',
        { method: 'POST' },
      ),
    );
    vi.unstubAllGlobals();
  });
});
