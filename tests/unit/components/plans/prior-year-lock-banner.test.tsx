// tests/unit/components/plans/prior-year-lock-banner.test.tsx
//
// The prior-year banner's CTA used to link to
// `/admin/plans/clone?from={planYear}&to={currentYear}`, a page that clones a
// WHOLE year and refuses when the target year already has plans — which is
// the normal state for the current year. The CTA now:
//   - opens the current-year version of the same plan when one exists;
//   - links to the clone page (prefilled) only when the current year has no
//     plans at all, i.e. when the clone can actually succeed;
//   - otherwise (the year has other plans) links to the new-plan wizard.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PriorYearLockBanner } from '@/components/plans/prior-year-lock-banner';

afterEach(cleanup);

type Status = 'has_plan' | 'empty' | 'other_plans';

function renderBanner(currentYearStatus: Status) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PriorYearLockBanner
        planId="diamond"
        planYear={2025}
        currentYear={2026}
        currentYearStatus={currentYearStatus}
      />
    </NextIntlClientProvider>,
  );
}

describe('PriorYearLockBanner CTA', () => {
  it('links to the current-year version of the plan when it exists', () => {
    renderBanner('has_plan');
    const link = screen.getByRole('link', { name: 'Open the 2026 version' });
    expect(link).toHaveAttribute('href', '/admin/plans/2026/diamond/edit');
    expect(screen.queryByRole('link', { name: /clone/i })).not.toBeInTheDocument();
  });

  it('links to the clone page prefilled with from/to when the current year has no plans', () => {
    renderBanner('empty');
    const link = screen.getByRole('link', { name: /2026/ });
    expect(link).toHaveAttribute('href', '/admin/plans/clone?from=2025&to=2026');
    expect(screen.queryByRole('link', { name: 'Open the 2026 version' })).not.toBeInTheDocument();
  });

  it('links to the new-plan wizard when the current year has other plans (clone would be refused)', () => {
    renderBanner('other_plans');
    const link = screen.getByRole('link', { name: 'Create the 2026 plan' });
    expect(link).toHaveAttribute('href', '/admin/plans/new');
    expect(screen.queryByRole('link', { name: /clone/i })).not.toBeInTheDocument();
  });
});
