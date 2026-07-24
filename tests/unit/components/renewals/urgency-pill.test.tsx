/**
 * F8 Phase 3 Wave H4 (verify-fix D1) — `<UrgencyPill>` unit tests.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import type { UrgencyBucket } from '@/modules/renewals';
// Pin against the REAL canonical EN copy (not an inline fixture) so a
// revert of the renewal-countdown wording back to a payment-due phrase
// ("Due in Xd") is caught here — the exact plan-change-ux seam 1(a) fix.
import en from '@/i18n/messages/en.json';

function renderPill(urgency: UrgencyBucket) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyPill urgency={urgency} />
    </NextIntlClientProvider>,
  );
}

describe('<UrgencyPill>', () => {
  it('renders localised label for each of the 8 urgency buckets', () => {
    const urgencies: ReadonlyArray<[UrgencyBucket, string]> = [
      ['t-90', 'Renews in 90d'],
      ['t-60', 'Renews in 60d'],
      ['t-30', 'Renews in 30d'],
      ['t-14', 'Renews in 14d'],
      ['t-7', 'Renews in 7d'],
      ['t-0', 'Renews today'],
      ['grace', 'Grace period'],
      ['lapsed', 'Lapsed'],
    ];
    for (const [urgency, label] of urgencies) {
      const { unmount } = renderPill(urgency);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });

  // plan-change-ux seam 1(a): the pre-expiry countdown buckets (t-90…t-0)
  // MUST read as a renewal countdown, never a payment-due demand — the
  // pipeline pairs them with an empty invoice cell, and "Due in Xd" +
  // blank invoice read to staff as "payment owed / unpaid". Only these
  // pre-expiry buckets are reworded; `grace` (post-expiry) + `lapsed`
  // (terminal) are genuine overdue/terminal states and stay unchanged.
  it('phrases the pre-expiry buckets as a renewal countdown, not a payment demand', () => {
    for (const urgency of ['t-90', 't-60', 't-30', 't-14', 't-7', 't-0'] as const) {
      const { container, unmount } = renderPill(urgency);
      const text = container.querySelector('span')!.textContent ?? '';
      expect(text).toMatch(/Renews/);
      expect(text).not.toMatch(/Due/);
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
    expect(el.textContent).toBe('Renews in 7d');
    expect(el.getAttribute('aria-label')).toBeNull();
  });

  it('applies whitespace-nowrap to keep pill on single line', () => {
    const { container } = renderPill('t-30');
    expect(container.querySelector('span')!.className).toMatch(/whitespace-nowrap/);
  });
});
