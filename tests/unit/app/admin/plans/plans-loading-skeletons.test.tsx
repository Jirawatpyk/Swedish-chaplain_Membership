/**
 * Route-level loading skeletons for /admin/plans/** mirror the pages they
 * stand in for:
 *   - edit: the flat PlanEditForm (Basics / Fees / Benefits sections + a
 *     Cancel + Save footer), not the 4-step wizard;
 *   - list: the filter bar includes the Year select;
 *   - detail: only the always-present benefit sections (the Partnership
 *     section exists only for partnership plans), plus header actions.
 * 122 US6 (T608): on AURA — every skeleton's surfaces are AURA cards, none
 * the legacy kit's (`data-slot="card"`), the list's filter row no longer the
 * legacy FilterBar.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import EditLoading from '@/app/(staff)/admin/plans/[year]/[planId]/edit/loading';
import ListLoading from '@/app/(staff)/admin/plans/loading';
import DetailLoading from '@/app/(staff)/admin/plans/[year]/[planId]/loading';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// FilterBar reads its own client translations and a media query (jsdom has
// no matchMedia).
function renderUi(ui: ReactElement) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function sections(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-skeleton-section]')].map(
    (el) => el.getAttribute('data-skeleton-section') ?? '',
  );
}

describe('plans loading skeletons', () => {
  it('edit mirrors the flat edit form, not the wizard', async () => {
    const { container } = renderUi(await EditLoading());
    expect(sections(container)).toEqual(['basics', 'fees', 'benefits']);
    // The wizard skeleton's step indicator (size-7 circles) must be gone.
    expect(container.querySelector('.size-7.rounded-full')).toBeNull();
    const footer = container.querySelector('[data-skeleton="footer"]');
    expect(footer?.querySelectorAll('[data-slot="skeleton-block"]').length).toBe(2);
    expect(container.querySelector('[data-skeleton-section="basics"]')?.closest('.aura-card')).not.toBeNull();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    // UX review (US6): the fee's currency is a suffix inside the field now,
    // so no leading currency block sits beside the input.
    const fees = container.querySelector('[data-skeleton-section="fees"]')!;
    expect(fees.querySelector('[data-skeleton="currency-prefix"], .h-5.w-6')).toBeNull();
  });

  it('list reserves a slot for the Year select', async () => {
    const { container } = renderUi(await ListLoading());
    const filters = container.querySelector('[data-skeleton="filters"]')!;
    expect(filters.querySelector('[data-skeleton="year-select"]')).not.toBeNull();
    expect(filters.closest('.aura-card')).not.toBeNull();
    expect(container.querySelector('[data-slot="filter-bar"], [data-slot="card"]')).toBeNull();
    // The filter pattern: one FilterBar row — the search, the Year and
    // Category faces and two toggle chips, no label lines above them — and
    // the count at the end of the row.
    expect(filters.querySelectorAll('[data-skeleton="labelled-field"]')).toHaveLength(0);
    expect(filters.querySelectorAll('[data-skeleton="filter-face"]')).toHaveLength(2);
    expect(filters.querySelectorAll('[data-skeleton="toggle-chip"]')).toHaveLength(2);
    expect(filters.querySelector('[data-skeleton="result-count"]')).not.toBeNull();
  });

  it('detail shows only the always-present benefit sections', async () => {
    const { container } = renderUi(await DetailLoading());
    expect(sections(container)).toEqual([
      'brandVisibility',
      'events',
      'additionalBenefits',
    ]);
    expect(container.querySelector('[data-skeleton="header-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-skeleton-section="events"]')?.closest('.aura-card')).not.toBeNull();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });
});

// The skeleton draws the list table as the page does: AURA's table, edge to
// edge inside the card (`bleed`), so nothing moves when the rows arrive.
describe('plans list loading in the list card', () => {
  it('draws AURA\'s table with the real column heads, edge to edge, before the VAT note', async () => {
    const { container } = renderUi(await ListLoading());
    const table = container.querySelector('.aura-card .aura-bleed');
    expect(table).not.toBeNull();
    const heads = [...container.querySelectorAll('.aura-card th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual(['columns.name', 'columns.category', 'columns.annualFee', 'columns.memberType', 'columns.year', 'columns.status']);
    expect(container.querySelector('[data-plan-list-skeleton] .border-b')).toBeNull();
  });
});

// UX review M1: on a phone the skeleton's cards take the real row's parts.
describe('plans list loading on a phone', () => {
  it('gives each skeleton row the real card parts: name as title, status as action, the year left out', async () => {
    const { container } = renderUi(await ListLoading());
    const row = container.querySelector('[data-plan-list-skeleton] tbody tr')!;
    const cells = [...row.querySelectorAll('td')];
    expect(cells[0]).toHaveAttribute('data-card', 'title');
    expect(cells[5]).toHaveAttribute('data-card', 'action');
    expect(cells[4]?.className).toContain('@max-[640px]/aura-tbl:hidden');
  });
});
