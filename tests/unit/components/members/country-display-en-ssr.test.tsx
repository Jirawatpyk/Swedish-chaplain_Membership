/**
 * C4 round-12 final-review polish (#3) — exercises the REAL
 * `i18n-iso-countries` module (no `vi.mock`) to verify the EN locale
 * is eager-registered at module load. This pins the SSR/first-paint
 * contract Round 11 introduced: "🇹🇭 Thailand" must render
 * synchronously for `variant="full"` + `locale="en"`, not flash via
 * "🇹🇭 TH" while `useEffect` waits for the dynamic locale import.
 *
 * Sibling file `country-display.test.tsx` mocks the module to keep
 * the variant-rendering tests deterministic across CI runs that
 * may lack the real `langs/*.json` files; this file lives apart so
 * the `vi.mock` hoisting doesn't bleed across both suites.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { CountryDisplay } from '@/components/members/country-display';

afterEach(() => cleanup());

describe('<CountryDisplay> — EN SSR eager-load contract', () => {
  it('renders the localised EN name immediately (no flash via raw code) for variant="full"', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <CountryDisplay code="TH" variant="full" />
      </NextIntlClientProvider>,
    );
    // The eager-registered EN locale (module-load side effect) means
    // `getName('TH', 'en')` resolves synchronously to "Thailand" on
    // first render. No useEffect tick needed.
    expect(container.textContent).toContain('🇹🇭');
    expect(container.textContent).toContain('Thailand');
    // Negative assertion: the visible text must NOT be the raw "TH"
    // fallback that older code paths produced before round-11.
    expect(container.textContent).not.toMatch(/🇹🇭\s*TH(?!ailand)/);
  });

  it('flag-only variant carries the localised name in the title attribute on first paint', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <CountryDisplay code="SE" variant="flag-only" />
      </NextIntlClientProvider>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    // title + aria-label both populated with the EN name immediately
    // (no async race). If the eager-load regressed, these would carry
    // the raw "SE" code instead of "Sweden".
    expect(wrapper.getAttribute('title')).toBe('Sweden');
    expect(wrapper.getAttribute('aria-label')).toBe('Sweden');
  });

  it('handles a valid-format-but-unassigned code (AA) without crashing', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <CountryDisplay code="AA" variant="full" />
      </NextIntlClientProvider>,
    );
    // i18n-iso-countries.getName returns null for unassigned codes
    // → component falls back to the raw "AA" alongside the
    // regional-indicator flag glyphs (which DO render even for
    // unassigned letter pairs since Unicode just maps codepoints).
    expect(container.textContent).toContain('AA');
  });
});
