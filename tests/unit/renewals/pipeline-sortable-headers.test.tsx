/**
 * `<PipelineTable>` sortable headers on AURA `DataTable` (spec 122 US7a,
 * T702). The URL stays the source of truth (FR-015): the page precomputes
 * `sortHrefs` (they keep `tier`/`urgency`/`month`, toggle the direction and
 * drop the paging `cursor`), and a click on a sortable header navigates to
 * the clicked column's href. The active column's header carries
 * `aria-sort=ascending|descending`, the other sortable one `none` (WCAG
 * 1.3.1). Without `sortHrefs` no header is sortable.
 *
 * Two rows: AURA only offers sorting when the page has more than one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

function row(cycleId: string, companyName: string): PipelineRow {
  return {
    cycleId: cycleId as PipelineRow['cycleId'],
    memberId: `m-${cycleId}`,
    companyName,
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    urgency: 't-30',
    status: 'upcoming' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    linkedInvoiceLive: false,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  };
}

const ROWS: ReadonlyArray<PipelineRow> = [row('c1', 'Acme Co'), row('c2', 'Beta Co')];
const SORT_HREFS = {
  expires: '/admin/renewals?urgency=t-30&sort=expires_at_asc',
  tier: '/admin/renewals?urgency=t-30&sort=tier_asc',
} as const;

function columnHeader(label: string): HTMLElement {
  return screen.getByRole('columnheader', { name: new RegExp(`^${label}`) });
}

beforeEach(() => {
  push.mockClear();
});

describe('<PipelineTable> sortable headers (AURA DataTable)', () => {
  it('a click on the Tier header navigates to its precomputed sort href', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ROWS} canMutate sort="tier_desc" sortHrefs={SORT_HREFS} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(within(columnHeader('Tier')).getByRole('button'));
    expect(push).toHaveBeenCalledWith(SORT_HREFS.tier);
  });

  it('a click on the Expires header navigates to its precomputed sort href', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ROWS} canMutate sort="tier_desc" sortHrefs={SORT_HREFS} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(within(columnHeader('Expires')).getByRole('button'));
    expect(push).toHaveBeenCalledWith(SORT_HREFS.expires);
  });

  it('stamps aria-sort on the active columnheader (descending) and none on the other sortable column', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ROWS} canMutate sort="tier_desc" sortHrefs={SORT_HREFS} />
      </NextIntlClientProvider>,
    );
    expect(columnHeader('Tier')).toHaveAttribute('aria-sort', 'descending');
    expect(columnHeader('Expires')).toHaveAttribute('aria-sort', 'none');
    // Non-sortable columns never carry aria-sort (axe aria-allowed-attr).
    expect(columnHeader('Company')).not.toHaveAttribute('aria-sort');
  });

  it('reflects the ascending direction for an expiry sort', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ROWS} canMutate sort="expires_at_asc" sortHrefs={SORT_HREFS} />
      </NextIntlClientProvider>,
    );
    expect(columnHeader('Expires')).toHaveAttribute('aria-sort', 'ascending');
    expect(columnHeader('Tier')).toHaveAttribute('aria-sort', 'none');
  });

  it('no header is sortable when sortHrefs is absent', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ROWS} canMutate />
      </NextIntlClientProvider>,
    );
    for (const col of screen.getAllByRole('columnheader')) {
      expect(col).not.toHaveAttribute('aria-sort');
    }
  });
});
