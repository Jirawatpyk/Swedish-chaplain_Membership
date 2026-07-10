/**
 * Task 11 — `<PipelineTable>` month-lens empty-state unit tests.
 *
 * Only exercises the empty-rows branch (`rows={[]}`) since that is
 * the only path touched by the `monthLabel` prop — non-empty rows
 * render `RowActionsMenu` (router + toast wiring) which is exercised
 * elsewhere and is unaffected by this change.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
