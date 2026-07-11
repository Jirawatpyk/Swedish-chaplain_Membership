/**
 * Deferred fix-wave-2 #4 + T9(b) — `<MonthFilterChip>` unit tests.
 *
 * First test coverage for the chip. Covers:
 *  - the three dedicated-copy branches (overdue / later / concrete month),
 *    proving `later` renders a SINGLE "or later" (not the pre-fix doubled
 *    "…or later or later" that composing the bar label into the frame gave);
 *  - the ✕ clear button pushing a URL that drops `month` + `cursor` + `nowIso`;
 *  - the WCAG 2.4.3 focus-restore FALLBACK to `#main-content` when the
 *    `#renewals-by-month` region is absent (section rendered its error branch).
 *
 * Follows the sibling tests' conventions: real `en.json`, `next/navigation`
 * mocked (no next-intl mock). `push` + the searchParams string are hoisted so
 * the mock factory can reference them and individual tests can enrich the URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MonthFilterChip } from '@/components/renewals/month-filter-chip';
import en from '@/i18n/messages/en.json';

const nav = vi.hoisted(() => ({ push: vi.fn(), search: 'month=2027-02' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

function renderChip(props: React.ComponentProps<typeof MonthFilterChip>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonthFilterChip {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  nav.push.mockClear();
  nav.search = 'month=2027-02';
  vi.unstubAllGlobals();
});

describe('<MonthFilterChip> dedicated-copy branches', () => {
  it('renders the dedicated overdue chip text when monthKind="overdue"', () => {
    renderChip({ monthKind: 'overdue' });
    expect(screen.getByText('Overdue renewals')).toBeDefined();
  });

  it('renders a SINGLE "or later" chip text when monthKind="later"', () => {
    renderChip({ monthKind: 'later', monthLabel: 'August 2028' });
    // Exact string — proves NOT doubled ("Renewing August 2028 or later or later").
    expect(screen.getByText('Renewing August 2028 or later')).toBeDefined();
    expect(screen.queryByText(/or later or later/)).toBeNull();
  });

  it('renders the framed "Renewing in {month}" chip text when monthKind="month"', () => {
    renderChip({ monthKind: 'month', monthLabel: 'December 2026' });
    expect(screen.getByText('Renewing in December 2026')).toBeDefined();
  });
});

describe('<MonthFilterChip> clear button', () => {
  it('pushes a URL that drops month + cursor + nowIso (keeps other params)', () => {
    nav.search = 'month=2027-02&cursor=abc123&nowIso=2027-01-01T00:00:00Z&urgency=t-30';
    renderChip({ monthKind: 'month', monthLabel: 'February 2027' });

    fireEvent.click(
      screen.getByRole('button', { name: /clear month filter/i }),
    );

    expect(nav.push).toHaveBeenCalledTimes(1);
    const url = nav.push.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('month=');
    expect(url).not.toContain('cursor=');
    expect(url).not.toContain('nowIso=');
    // A non-lens param survives the clear.
    expect(url).toContain('urgency=t-30');
  });

  it('pushes the bare pathname when month was the only param', () => {
    nav.search = 'month=2027-02';
    renderChip({ monthKind: 'month', monthLabel: 'February 2027' });

    fireEvent.click(
      screen.getByRole('button', { name: /clear month filter/i }),
    );

    expect(nav.push).toHaveBeenCalledWith('/admin/renewals');
  });
});

describe('<MonthFilterChip> focus-restore fallback (WCAG 2.4.3)', () => {
  it('focuses #main-content when the #renewals-by-month region is absent', () => {
    // Simulate the section error-branch: NO #renewals-by-month in the DOM,
    // but the layout landmark #main-content is present + focusable.
    const main = document.createElement('div');
    main.id = 'main-content';
    main.tabIndex = -1;
    document.body.appendChild(main);
    const focusSpy = vi.spyOn(main, 'focus');

    // clear() defers the focus into a requestAnimationFrame — run it
    // synchronously so the assertion sees the resolved focus.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      },
    );

    try {
      renderChip({ monthKind: 'overdue' });
      // Sanity: the region really is absent.
      expect(document.getElementById('renewals-by-month')).toBeNull();

      fireEvent.click(
        screen.getByRole('button', { name: /clear month filter/i }),
      );

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(main);
    } finally {
      document.body.removeChild(main);
    }
  });
});
