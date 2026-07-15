/**
 * Unit test: DirectoryFilters search input — focus-loss regression guard
 * (branch 065-members-search-focus-loss).
 *
 * The headline bug: the search <Input> carried `key={currentQ}`, so every
 * debounced URL update remounted it — dropping keyboard focus mid-type (you
 * couldn't type past one debounce window) and resetting the value. The fix
 * makes the input CONTROLLED and reconciles FROM the URL only when the input
 * is NOT focused, so active typing is never disturbed. This is a React
 * state/remount behaviour (not layout), so jsdom exercises it faithfully.
 *
 * Covers:
 *  1. Debounced typing pushes the TRIMMED `q` to the URL with `{ scroll:false }`
 *     (the "table jumps on every keystroke" regression).
 *  2. Focus + typed value survive a URL `q` update that lands WHILE the input
 *     is focused — even when the URL lags behind the latest keystrokes (the
 *     "reverted to an in-flight debounced value" regression).
 *  3. When the input is NOT focused, it reconciles from the URL (browser
 *     back/forward / shared link / programmatic clear).
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DirectoryFilters } from '@/components/members/directory-filters';

// Base UI Select (status/risk filters) touches PointerEvent on render; jsdom lacks it.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

// Mutable navigation state so a test can simulate Next re-rendering the tree
// with a new `q` in the URL (what `router.replace` triggers in production).
const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock }),
  usePathname: () => '/admin/members',
  useSearchParams: () => nav.searchParams.current,
}));

const messages = {
  admin: {
    members: {
      directory: {
        searchPlaceholder: 'Search',
        searchSrLabel: 'Search members',
        clearFilters: 'Clear',
        filters: {
          status: {
            label: 'Status',
            all: 'All',
            active: 'Active',
            inactive: 'Inactive',
            archived: 'Archived',
          },
          plan: { label: 'Plan', all: 'All plans' },
          risk: {
            label: 'Risk',
            all: 'All',
            healthy: 'Healthy',
            warning: 'Warning',
            'at-risk': 'At risk',
            critical: 'Critical',
          },
        },
      },
    },
  },
};

function renderFilters() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectoryFilters />
    </NextIntlClientProvider>,
  );
}

function rerenderFilters(rerender: (ui: React.ReactElement) => void) {
  rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectoryFilters />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  nav.replaceMock.mockClear();
  nav.searchParams.current = new URLSearchParams();
});

describe('DirectoryFilters — search input focus/URL sync', () => {
  it('debounced typing pushes the trimmed q to the URL with scroll:false', () => {
    vi.useFakeTimers();
    try {
      renderFilters();
      const input = screen.getByRole('searchbox') as HTMLInputElement;

      fireEvent.change(input, { target: { value: '  acme  ' } });
      // Controlled: the keystroke shows immediately, before the debounce.
      expect(input.value).toBe('  acme  ');
      expect(nav.replaceMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(nav.replaceMock).toHaveBeenCalledTimes(1);
      const [url, opts] = nav.replaceMock.mock.calls[0] as [string, { scroll: boolean }];
      expect(url).toContain('q=acme'); // trimmed
      // A filter refine must NOT scroll the page to the top on each keystroke.
      expect(opts).toEqual({ scroll: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps focus and the typed value when a lagging URL q lands while focused', () => {
    const { rerender } = renderFilters();
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    input.focus();
    expect(document.activeElement).toBe(input);

    // User types ahead of the debounce.
    fireEvent.change(input, { target: { value: 'swe' } });
    expect(input.value).toBe('swe');

    // Next applies an EARLIER debounced value (URL lags one keystroke behind)
    // and re-renders the tree while the box is still focused.
    nav.searchParams.current = new URLSearchParams('q=sw');
    act(() => {
      rerenderFilters(rerender);
    });

    // No remount (focus retained) and the reconcile is suppressed while focused
    // (value NOT reverted to the in-flight 'sw').
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('swe');
  });

  it('reconciles the input from the URL when it is NOT focused (back/forward)', () => {
    nav.searchParams.current = new URLSearchParams('q=initial');
    const { rerender } = renderFilters();
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    // Never focused → initial value comes from the URL.
    expect(input.value).toBe('initial');

    // An external navigation changes the URL while the box is unfocused.
    nav.searchParams.current = new URLSearchParams('q=external');
    act(() => {
      rerenderFilters(rerender);
    });

    expect(input.value).toBe('external');
  });
});
