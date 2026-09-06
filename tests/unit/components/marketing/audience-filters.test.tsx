/**
 * 108 PR-D review cycle 11 (UX H1 / H2 / M5, a11y 6 / 7) — `AudienceFilters`.
 *
 * URL search params are the single source of truth. Pinned here:
 *   - the search box RE-SYNCS from the URL when `q` changes underneath it
 *     (Clear-filters CTA, the pre-flight preset, browser back/forward) — but
 *     NEVER mid-type (the input is focused);
 *   - "Clear filters" moves focus to the always-present search input BEFORE
 *     the button unmounts (a focus-loss class axe never catches);
 *   - each select trigger's accessible name carries the CURRENT value, so a
 *     screen reader hears "Contact role: Secondary only", not just the label;
 *   - the eligibility trigger sizes to its content (`min-w`), never clipping
 *     the selected SV/TH value (FR-035c "wrap rather than truncate");
 *   - `enterKeyHint="search"` on the search input (mobile keyboards).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

let currentParams = new URLSearchParams();
const replaceSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceSpy, refresh: vi.fn() }),
  usePathname: () => '/admin/marketing/audience',
  useSearchParams: () => currentParams,
}));

import { AudienceFilters } from '@/app/(staff)/admin/marketing/audience/_components/audience-filters';

const t = en.admin.marketing.audience.filters;

function renderFilters(query = '') {
  currentParams = new URLSearchParams(query);
  // A FRESH element per render — React bails out of re-rendering a root
  // whose child element is the same reference.
  const ui = () => (
    <NextIntlClientProvider locale="en" messages={en}>
      <AudienceFilters />
    </NextIntlClientProvider>
  );
  const result = render(ui());
  return {
    ...result,
    /** Simulate a navigation that changed the URL (Clear CTA, preset, back). */
    navigateTo(nextQuery: string) {
      currentParams = new URLSearchParams(nextQuery);
      result.rerender(ui());
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
  replaceSpy.mockClear();
});
afterEach(() => cleanup());

describe('AudienceFilters — URL is the source of truth (cycle 11)', () => {
  it('re-syncs the search box when the URL drops q and the input is not focused', () => {
    const { navigateTo } = renderFilters('q=Acme');
    const input = screen.getByRole('searchbox', { name: t.searchLabel });
    expect(input).toHaveValue('Acme');
    navigateTo('');
    expect(input).toHaveValue('');
  });

  it('never clobbers the search box mid-type (input focused)', () => {
    const { navigateTo } = renderFilters('q=Acme');
    const input = screen.getByRole('searchbox', { name: t.searchLabel });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Acme Corp' } });
    navigateTo('q=Acme');
    expect(input).toHaveValue('Acme Corp');
  });

  it('"Clear filters" hands focus to the search input before the button unmounts', () => {
    const { navigateTo } = renderFilters('q=Acme&kind=secondary');
    const clear = screen.getByRole('button', { name: t.clear });
    act(() => clear.focus());
    fireEvent.click(clear);
    const input = screen.getByRole('searchbox', { name: t.searchLabel });
    expect(document.activeElement).toBe(input);
    expect(replaceSpy).toHaveBeenCalledWith('/admin/marketing/audience', { scroll: false });
    navigateTo('');
    expect(screen.queryByRole('button', { name: t.clear })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('the search input advertises enterKeyHint="search"', () => {
    renderFilters();
    expect(screen.getByRole('searchbox', { name: t.searchLabel })).toHaveAttribute(
      'enterkeyhint',
      'search',
    );
  });
});

describe('AudienceFilters — select triggers (cycle 11)', () => {
  it('each trigger names itself with label AND current value', () => {
    renderFilters('kind=secondary&state=on');
    const triggers = screen.getAllByRole('combobox');
    const names = triggers.map((el) => el.getAttribute('aria-label'));
    expect(names).toContain(`${t.kindLabel}: ${t.kind.secondary}`);
    expect(names).toContain(`${t.stateLabel}: ${t.state.on}`);
    expect(names).toContain(`${t.eligibleLabel}: ${t.eligible.on}`);
  });

  it('the eligibility trigger sizes to content (min-w), never a fixed width', () => {
    renderFilters();
    const trigger = screen
      .getAllByRole('combobox')
      .find((el) => el.getAttribute('aria-label')?.startsWith(t.eligibleLabel));
    expect(trigger).toBeDefined();
    expect(trigger!.className).toContain('sm:min-w-52');
    expect(trigger!.className).not.toMatch(/\bsm:w-52\b/);
  });
});
