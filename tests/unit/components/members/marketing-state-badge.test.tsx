/**
 * 108 PR-D T056 (FR-031, FR-031a, FR-051) — `MarketingStateBadge`.
 *
 * Five states, each a VISIBLE text label plus an icon — never colour alone
 * (WCAG 1.4.1). The non-"on" states carry an accessible sentence so a screen
 * reader hears WHY the contact will not receive, not just a badge word.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MarketingStateBadge } from '@/components/members/marketing-state-badge';
import type { MarketingState } from '@/modules/members';

const labels = en.shared.marketing.state;

function renderBadge(state: MarketingState) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MarketingStateBadge state={state} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('MarketingStateBadge', () => {
  it.each([
    ['on', labels.on],
    ['off_by_staff', labels.off_by_staff],
    ['off_by_contact', labels.off_by_contact],
    ['unsubscribed', labels.unsubscribed],
    ['unavailable', labels.unavailable],
  ] as const)('%s → visible text "%s" with an icon', (state, text) => {
    const { container } = renderBadge(state);
    expect(screen.getByText(text)).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['off_by_staff', labels.off_by_staffAria],
    ['off_by_contact', labels.off_by_contactAria],
    ['unsubscribed', labels.unsubscribedAria],
    ['unavailable', labels.unavailableAria],
  ] as const)('%s carries the explanatory accessible name', (state, aria) => {
    renderBadge(state);
    expect(screen.getByLabelText(aria)).toBeInTheDocument();
  });

  it('exposes the state as a data attribute for e2e + styling hooks', () => {
    const { container } = renderBadge('off_by_staff');
    expect(container.querySelector('[data-marketing-state="off_by_staff"]')).not.toBeNull();
  });
});
