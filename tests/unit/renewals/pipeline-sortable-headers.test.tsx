/**
 * Wave 2 Task 8 — `<PipelineTable>` sortable headers.
 *
 * When `sort` + `sortHrefs` are supplied (the page always wires both) the
 * `tier`/`expires` headers render as anchor links to the precomputed sort
 * hrefs, the active column's `<th>` carries `aria-sort=ascending|descending`
 * and the other sortable column `aria-sort=none` (WCAG 1.3.1). Without the
 * props the headers stay plain text — the backwards-compatible path other
 * callers/tests rely on. Rendered with `rows={[]}` (headers render regardless
 * of rows; no `RowActions`, hence no Base UI menu to mock).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

const EMPTY_ROWS: ReadonlyArray<PipelineRow> = [];
const SORT_HREFS = {
  expires: '/admin/renewals?urgency=t-30&sort=expires_at_asc',
  tier: '/admin/renewals?urgency=t-30&sort=tier_asc',
} as const;

function columnHeader(label: string): HTMLElement {
  const col = screen
    .getAllByRole('columnheader')
    .find((c) => c.textContent?.includes(label));
  if (!col) throw new Error(`no columnheader containing "${label}"`);
  return col;
}

describe('<PipelineTable> sortable headers', () => {
  it('renders tier/expires headers as sort links with the precomputed hrefs', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate sort="tier_desc" sortHrefs={SORT_HREFS} />
      </NextIntlClientProvider>,
    );
    const tierLink = screen.getByRole('link', { name: 'Sort by Tier' });
    expect(tierLink).toHaveAttribute('href', SORT_HREFS.tier);
    const expiresLink = screen.getByRole('link', { name: 'Sort by Expires' });
    expect(expiresLink).toHaveAttribute('href', SORT_HREFS.expires);
  });

  it('stamps aria-sort on the active columnheader (descending) and none on the other sortable column', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate sort="tier_desc" sortHrefs={SORT_HREFS} />
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
        <PipelineTable
          rows={EMPTY_ROWS}
          canMutate
          sort="expires_at_asc"
          sortHrefs={SORT_HREFS}
        />
      </NextIntlClientProvider>,
    );
    expect(columnHeader('Expires')).toHaveAttribute('aria-sort', 'ascending');
    expect(columnHeader('Tier')).toHaveAttribute('aria-sort', 'none');
  });

  it('renders plain headers with no links or aria-sort when sortHrefs is absent', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('link', { name: /sort by/i })).toBeNull();
    for (const col of screen.getAllByRole('columnheader')) {
      expect(col).not.toHaveAttribute('aria-sort');
    }
  });
});
