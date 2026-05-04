/**
 * F8 Phase 3 Wave H4 (verify-fix D1) — `<TierBadge>` unit tests.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TierBadge } from '@/components/renewals/tier-badge';
import type { TierBucket } from '@/modules/renewals';

const messages = {
  admin: {
    renewals: {
      tierBadge: {
        thai_alumni: 'Thai alumni',
        start_up: 'Start-up',
        regular: 'Regular',
        premium: 'Premium',
        partnership: 'Partnership',
      },
    },
  },
};

function renderBadge(tier: TierBucket) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TierBadge tier={tier} />
    </NextIntlClientProvider>,
  );
}

describe('<TierBadge>', () => {
  it('renders the localised label for each of the 5 tier buckets', () => {
    const tiers: ReadonlyArray<[TierBucket, string]> = [
      ['thai_alumni', 'Thai alumni'],
      ['start_up', 'Start-up'],
      ['regular', 'Regular'],
      ['premium', 'Premium'],
      ['partnership', 'Partnership'],
    ];
    for (const [tier, label] of tiers) {
      const { unmount } = renderBadge(tier);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });

  it('exposes aria-label for screen readers', () => {
    renderBadge('premium');
    expect(screen.getByLabelText('Premium')).toBeDefined();
  });

  it('applies tier-specific colour classes', () => {
    const { container } = renderBadge('premium');
    const el = container.querySelector('span')!;
    expect(el.className).toMatch(/bg-purple/);
  });

  it('merges custom className', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TierBadge tier="regular" className="custom-x" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Regular').className).toMatch(/custom-x/);
  });
});
