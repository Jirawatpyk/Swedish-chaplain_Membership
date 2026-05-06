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

  it('K12-2 (UX-K-6): visible text serves as accessible name (no redundant aria-label)', () => {
    // K12-2 polish: removed `aria-label={label}` from UrgencyPill —
    // mirrors K9 closure on TierBadge + LapsedTab reason badge. Older
    // VoiceOver versions double-announce when aria-label matches the
    // visible text on a non-interactive `<span>`. The visible text
    // alone correctly serves as the accessible name (WCAG 1.1 + 4.1.2).
    const { container } = renderPill('t-7');
    const el = container.querySelector('span')!;
    expect(el.textContent).toBe('Due in 7d');
    expect(el.getAttribute('aria-label')).toBeNull();
  });

  it('applies whitespace-nowrap to keep pill on single line', () => {
    const { container } = renderPill('t-30');
    expect(container.querySelector('span')!.className).toMatch(/whitespace-nowrap/);
  });
});
