/**
 * F8 Phase 3 Wave H4 (verify-fix D1) — `<UrgencyPill>` unit tests.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import type { UrgencyBucket } from '@/modules/renewals';

const messages = {
  admin: {
    renewals: {
      urgencyPill: {
        t_90: 'Due in 90d',
        t_60: 'Due in 60d',
        t_30: 'Due in 30d',
        t_14: 'Due in 14d',
        t_7: 'Due in 7d',
        t_0: 'Due today',
        grace: 'Grace period',
        lapsed: 'Lapsed',
      },
    },
  },
};

function renderPill(urgency: UrgencyBucket) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <UrgencyPill urgency={urgency} />
    </NextIntlClientProvider>,
  );
}

describe('<UrgencyPill>', () => {
  it('renders localised label for each of the 8 urgency buckets', () => {
    const urgencies: ReadonlyArray<[UrgencyBucket, string]> = [
      ['t-90', 'Due in 90d'],
      ['t-60', 'Due in 60d'],
      ['t-30', 'Due in 30d'],
      ['t-14', 'Due in 14d'],
      ['t-7', 'Due in 7d'],
      ['t-0', 'Due today'],
      ['grace', 'Grace period'],
      ['lapsed', 'Lapsed'],
    ];
    for (const [urgency, label] of urgencies) {
      const { unmount } = renderPill(urgency);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });

  it('uses red palette for t-0 (most urgent)', () => {
    const { container } = renderPill('t-0');
    expect(container.querySelector('span')!.className).toMatch(/bg-red-100/);
  });

  it('uses dashed-border red for grace', () => {
    const { container } = renderPill('grace');
    expect(container.querySelector('span')!.className).toMatch(/ring-dashed/);
  });

  it('uses gray for lapsed (terminal)', () => {
    const { container } = renderPill('lapsed');
    expect(container.querySelector('span')!.className).toMatch(/bg-gray-100/);
  });

  it('exposes aria-label', () => {
    renderPill('t-7');
    expect(screen.getByLabelText('Due in 7d')).toBeDefined();
  });

  it('applies whitespace-nowrap to keep pill on single line', () => {
    const { container } = renderPill('t-30');
    expect(container.querySelector('span')!.className).toMatch(/whitespace-nowrap/);
  });
});
