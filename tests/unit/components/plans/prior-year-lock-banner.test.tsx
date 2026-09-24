// tests/unit/components/plans/prior-year-lock-banner.test.tsx
//
// The prior-year banner's CTA used to link to
// `/admin/plans/clone?from={planYear}&to={currentYear}`, a page that clones a
// WHOLE year and refuses when the target year already has plans — which is
// the normal state for the current year. The CTA now opens the current-year
// version of the same plan when one exists, and only falls back to the clone
// page when it does not.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PriorYearLockBanner } from '@/components/plans/prior-year-lock-banner';

afterEach(cleanup);

function renderBanner(currentYearPlanExists: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PriorYearLockBanner
        planId="diamond"
        planYear={2025}
        currentYear={2026}
        currentYearPlanExists={currentYearPlanExists}
      />
    </NextIntlClientProvider>,
  );
}

describe('PriorYearLockBanner CTA', () => {
  it('links to the current-year version of the plan when it exists', () => {
    renderBanner(true);
    const link = screen.getByRole('link', { name: 'Open the 2026 version' });
    expect(link).toHaveAttribute('href', '/admin/plans/2026/diamond/edit');
    expect(screen.queryByRole('link', { name: /clone/i })).not.toBeInTheDocument();
  });

  it('falls back to the clone page prefilled with from/to when there is no current-year version', () => {
    renderBanner(false);
    const link = screen.getByRole('link', { name: /2026/ });
    expect(link).toHaveAttribute('href', '/admin/plans/clone?from=2025&to=2026');
    expect(screen.queryByRole('link', { name: 'Open the 2026 version' })).not.toBeInTheDocument();
  });
});
