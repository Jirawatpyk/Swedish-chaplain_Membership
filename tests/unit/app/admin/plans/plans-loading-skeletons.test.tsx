/**
 * Route-level loading skeletons for /admin/plans/** mirror the pages they
 * stand in for:
 *   - edit: the flat PlanEditForm (Basics / Fees / Benefits sections + a
 *     Cancel + Save footer), not the 4-step wizard;
 *   - list: the filter bar includes the Year select;
 *   - detail: only the always-present benefit sections (the Partnership
 *     section exists only for partnership plans), plus header actions.
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
  });

  it('list reserves a slot for the Year select', async () => {
    const { container } = renderUi(await ListLoading());
    const filterBar = container.querySelector('[data-slot="filter-bar"]')!;
    expect(filterBar.querySelector('[data-skeleton="year-select"]')).not.toBeNull();
  });

  it('detail shows only the always-present benefit sections', async () => {
    const { container } = renderUi(await DetailLoading());
    expect(sections(container)).toEqual([
      'brandVisibility',
      'events',
      'additionalBenefits',
    ]);
    expect(container.querySelector('[data-skeleton="header-actions"]')).not.toBeNull();
  });
});
