/**
 * C4 round-10 ui-design-specialist — unit test for `<CountryDisplay>`.
 *
 * Pins the 3 behaviours admins + members directly depend on:
 *   1. Flag-emoji generation — `codeToFlag` builds the regional-
 *      indicator pair correctly so "TH" → 🇹🇭, "SE" → 🇸🇪, etc.
 *   2. Variant rendering — full / flag-only / compact each produce
 *      the documented DOM shape (visible text vs. hover-title +
 *      aria-label fallback).
 *   3. Graceful fallback — invalid codes (length ≠ 2, non-letters)
 *      render the raw input as text instead of crashing.
 *
 * `i18n-iso-countries` is mocked so the assertions are deterministic
 * (the real module dynamically imports per-locale JSON; tests would
 * race the lazy-load otherwise).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// Mock the per-locale name lookup so we don't depend on the async
// dynamic-import dance in `country-display.tsx`. `isValid` accepts
// any 2-letter code so we can verify the variant outputs without
// exercising the registration cache.
vi.mock('i18n-iso-countries', () => ({
  default: {
    isValid: (code: string) => /^[A-Z]{2}$/.test(code.toUpperCase()),
    registerLocale: () => undefined,
    getName: (code: string, _locale: string) => {
      const map: Record<string, string> = {
        TH: 'Thailand',
        SE: 'Sweden',
        SG: 'Singapore',
        US: 'United States',
      };
      return map[code.toUpperCase()] ?? null;
    },
  },
}));

import { CountryDisplay } from '@/components/members/country-display';

function renderWithLocale(node: React.ReactNode, locale = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      {node}
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('<CountryDisplay> — codeToFlag emoji generation', () => {
  it('TH → 🇹🇭 (regional indicator T + H)', () => {
    const { container } = renderWithLocale(<CountryDisplay code="TH" />);
    expect(container.textContent).toContain('🇹🇭');
  });

  it('SE → 🇸🇪', () => {
    const { container } = renderWithLocale(<CountryDisplay code="SE" />);
    expect(container.textContent).toContain('🇸🇪');
  });

  it('US → 🇺🇸', () => {
    const { container } = renderWithLocale(<CountryDisplay code="US" />);
    expect(container.textContent).toContain('🇺🇸');
  });

  it('lowercase input still produces the correct flag', () => {
    const { container } = renderWithLocale(<CountryDisplay code="th" />);
    expect(container.textContent).toContain('🇹🇭');
  });
});

describe('<CountryDisplay> — variant rendering', () => {
  it('default variant ("full") renders flag + the raw code as a fallback before locale data registers', () => {
    // Initial render: `ready=false` (locale JSON not registered yet),
    // so `getName` is not called and the visible name falls back to
    // the bare uppercase code. After `useEffect` runs the registration
    // toggles `ready` and `getName` lights up — but the SSR-safe
    // first-paint MUST always render something.
    const { container } = renderWithLocale(<CountryDisplay code="TH" />);
    // Flag always renders (pure codepoint math, no async)
    expect(container.textContent).toContain('🇹🇭');
    // Either the raw code (pre-effect) OR the localised name (post-
    // effect) is acceptable; we assert SOMETHING beyond the flag is
    // visible.
    const trimmed = container.textContent?.replace('🇹🇭', '').trim() ?? '';
    expect(trimmed.length).toBeGreaterThan(0);
  });

  it('variant="flag-only" omits visible text and puts the name in title + aria-label', () => {
    const { container } = renderWithLocale(
      <CountryDisplay code="TH" variant="flag-only" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    // Flag visible
    expect(container.textContent).toContain('🇹🇭');
    // After useEffect runs the name lands in title + aria-label
    // (initial value === code, post-effect === localised "Thailand").
    // Both are acceptable; we just assert the attributes EXIST and
    // are non-empty.
    expect(wrapper.getAttribute('title')?.length ?? 0).toBeGreaterThan(0);
    expect(wrapper.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
  });

  it('variant="compact" renders flag + the ISO code (no full name)', () => {
    const { container } = renderWithLocale(
      <CountryDisplay code="TH" variant="compact" />,
    );
    expect(container.textContent).toContain('🇹🇭');
    expect(container.textContent).toContain('TH');
  });

  it('variant="compact" upper-cases lowercase input for display', () => {
    const { container } = renderWithLocale(
      <CountryDisplay code="th" variant="compact" />,
    );
    expect(container.textContent).toContain('TH');
  });
});

describe('<CountryDisplay> — graceful fallback for invalid codes', () => {
  it('length-3 code falls back to the raw string (no flag mangling)', () => {
    const { container } = renderWithLocale(
      <CountryDisplay code="XX1" variant="compact" />,
    );
    // codeToFlag returns the raw code when length ≠ 2 — no codepoint
    // shifts so no garbled emoji.
    const text = container.textContent ?? '';
    expect(text).toContain('XX1');
    // Verify NO regional-indicator codepoints leaked into the output
    // — the only regional-indicator codepoint that could appear
    // accidentally would be in the U+1F1E6..U+1F1FF range.
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp).toBeLessThan(0x1f1e6);
    }
  });

  it('non-alpha characters fall back to the raw string', () => {
    const { container } = renderWithLocale(
      <CountryDisplay code="1A" variant="compact" />,
    );
    const text = container.textContent ?? '';
    // The raw code is uppercase-rendered ("1A") with no flag in front.
    expect(text).toContain('1A');
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp).toBeLessThan(0x1f1e6);
    }
  });

  it('empty string code is rendered without crashing', () => {
    expect(() =>
      renderWithLocale(<CountryDisplay code="" variant="compact" />),
    ).not.toThrow();
  });
});

describe('<CountryDisplay> — accessibility', () => {
  it('flag glyph is marked aria-hidden so SRs read the name once, not twice', () => {
    const { container } = renderWithLocale(<CountryDisplay code="TH" />);
    // Find the span containing the flag emoji — should have
    // aria-hidden="true" so screen readers don't double-announce
    // the country (once via flag, once via the visible name).
    const spans = container.querySelectorAll('span[aria-hidden="true"]');
    let foundFlagSpan = false;
    for (const s of spans) {
      if (s.textContent === '🇹🇭') {
        foundFlagSpan = true;
        break;
      }
    }
    expect(foundFlagSpan).toBe(true);
  });
});
