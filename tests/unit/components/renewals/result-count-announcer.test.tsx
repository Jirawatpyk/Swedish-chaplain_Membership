/**
 * Task 11 — `<ResultCountAnnouncer>` month-lens unit tests.
 *
 * Covers the two new conditional branches added for the renewals-by-
 * month feature: `monthLabel` (month lens) takes priority over
 * `urgencyKey` (bucket lens); with neither, the live region is empty.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ResultCountAnnouncer } from '@/components/renewals/result-count-announcer';
import en from '@/i18n/messages/en.json';

describe('<ResultCountAnnouncer> month lens', () => {
  it('announces the month-lens copy when monthLabel is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResultCountAnnouncer count={3} monthLabel="December 2026" />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('December 2026');
    expect(region.textContent).toContain('3');
  });

  it('announces the urgency-bucket copy when only urgencyKey is set (no monthLabel)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResultCountAnnouncer count={5} urgencyKey="t-30" />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('T-30');
    expect(region.textContent).toContain('5');
  });

  it('renders an empty live region when neither monthLabel nor urgencyKey is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResultCountAnnouncer count={0} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
