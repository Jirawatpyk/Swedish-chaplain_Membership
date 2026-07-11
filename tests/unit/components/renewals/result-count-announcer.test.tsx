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

  // Deferred fix-wave-2 #4 — dedicated overdue/later SR copy. The bug being
  // pinned: pre-fix the announcer composed the bucket label into the generic
  // "Showing # members renewing in {month}" frame, producing
  // "renewing in Overdue" / a doubled "…or later or later".
  it('announces dedicated overdue copy when monthKind="overdue"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResultCountAnnouncer count={3} monthKind="overdue" />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('3 overdue members');
    expect(region.textContent).toBe('Showing 3 overdue members');
  });

  it('announces dedicated later copy (singular branch, single "or later") when monthKind="later"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ResultCountAnnouncer
          count={1}
          monthKind="later"
          monthLabel="August 2028"
        />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('status');
    // count=1 → singular ICU branch ("member", not "members").
    expect(region.textContent).toContain('1 member');
    expect(region.textContent).toContain('renewing August 2028 or later');
    // Exact string — proves the copy is NOT doubled ("…or later or later").
    expect(region.textContent).toBe(
      'Showing 1 member renewing August 2028 or later',
    );
  });
});
