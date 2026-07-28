/**
 * Wave 1 Task 2 (item ④) — `<ResultCountLabel>` unit tests.
 *
 * Mirrors `result-count-announcer.test.tsx`: same branch logic, same
 * `admin.renewals.table.srResultCount*` message keys — but this surface is
 * VISIBLE (`aria-hidden`) rather than a screen-reader-only live region. The
 * sr-only `<ResultCountAnnouncer>` still owns the SR channel; this is its
 * sighted twin so a mouse/keyboard admin can see the result count next to
 * the filter row without opening a screen reader.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ResultCountLabel } from '@/components/renewals/result-count-label';
import en from '@/i18n/messages/en.json';

function renderLabel(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('<ResultCountLabel>', () => {
  it('shows the urgency-bucket count and is aria-hidden (announcer owns the SR channel)', () => {
    renderLabel(<ResultCountLabel count={5} urgencyKey="t-30" />);
    const el = screen.getByText('Showing 5 members in T-30');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the month-lens count when monthKind/monthLabel are set', () => {
    renderLabel(
      <ResultCountLabel count={3} monthKind="month" monthLabel="December 2026" />,
    );
    expect(
      screen.getByText('Showing 3 members renewing in December 2026'),
    ).toBeDefined();
  });

  it('renders nothing when neither lens is set', () => {
    const { container } = renderLabel(<ResultCountLabel count={0} />);
    expect(container.firstChild).toBeNull();
  });
});
