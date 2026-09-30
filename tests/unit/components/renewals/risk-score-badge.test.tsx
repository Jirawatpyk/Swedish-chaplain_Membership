/**
 * `<RiskScoreBadge>` — the at-risk score and band as one labelled AURA badge
 * (spec 122 US7a, T709).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RiskScoreBadge, type RiskBand } from '@/components/renewals/risk-score-badge';
import en from '@/i18n/messages/en.json';

function renderBadge(band: RiskBand, score = 82) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RiskScoreBadge score={score} band={band} activeMax={100} />
    </NextIntlClientProvider>,
  );
}

describe('<RiskScoreBadge>', () => {
  it('reads as one labelled element: score, maximum and band', () => {
    renderBadge('critical');
    const badge = screen.getByRole('img', { name: 'Risk score 82 out of 100, band Critical' });
    expect(badge).toHaveTextContent('82·Critical');
  });

  it.each([
    ['healthy', 'aura-badge--success', ''],
    ['warning', 'aura-badge--warning', ''],
    ['at-risk', 'aura-badge--danger', ''],
    ['critical', 'aura-badge--danger', 'is-solid'],
  ] as const)('122 US7a: %s is an AURA badge (%s %s)', (band, tone, variant) => {
    renderBadge(band);
    const badge = screen.getByRole('img');
    expect(badge).toHaveClass('aura-badge', tone);
    if (variant) expect(badge).toHaveClass(variant);
    else expect(badge).not.toHaveClass('is-solid');
  });
});
