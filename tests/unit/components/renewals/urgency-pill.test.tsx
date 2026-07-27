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
      ['suspended', 'Suspended'],
      ['terminated', 'Terminated'],
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
  // pre-expiry buckets are reworded; `suspended` (benefits paused) +
  // `terminated` (membership ended) are genuine access states and stay as-is.
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

  it('uses a solid amber fill for suspended, distinct from the t-14 countdown', () => {
    const suspended = renderPill('suspended');
    const suspendedClass =
      suspended.container.querySelector('span')!.className;
    // The real differentiator is the fill/ring shade (Tailwind rings can't be
    // dashed). Suspended is the enterprise-ux-signed-off amber-300 solid fill
    // (dark amber-800) + ring-amber-500; t-14 is the pale amber-100 tint.
    expect(suspendedClass).toMatch(/bg-amber-300/);
    expect(suspendedClass).toMatch(/dark:bg-amber-800/);
    expect(suspendedClass).toMatch(/ring-amber-500/);
    suspended.unmount();

    const t14 = renderPill('t-14');
    const t14Class = t14.container.querySelector('span')!.className;
    // Guard the collision the review caught: the two amber pills must NOT
    // share a fill class.
    expect(t14Class).not.toMatch(/bg-amber-300/);
    t14.unmount();
  });

  it('uses gray for terminated (membership ended)', () => {
    const { container } = renderPill('terminated');
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
