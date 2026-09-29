/**
 * Active-filter chips in `<DirectoryFilters>` (ux-standards §9.4).
 *
 * A dismissible chip row summarizes the filters hidden inside the Selects
 * (q / status / plan / risk). Each chip's × clears ONLY its own filter via
 * `pushUrl({ key: null })` (the same clear the Selects use). The needs-invite
 * chip is NOT duplicated here — it stays its own toggle.
 *
 * Uses the real `src/i18n/messages/en.json` so a missing key fails the test.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DirectoryFilters } from '@/components/members/directory-filters';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI Select)
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock }),
  usePathname: () => '/admin/members',
  useSearchParams: () => nav.searchParams.current,
}));

beforeEach(() => {
  nav.replaceMock.mockClear();
  nav.searchParams.current = new URLSearchParams();
});

const PLANS = [{ id: 'p1', label: 'Premium Corporate' }];

function renderFilters(searchParams?: string) {
  nav.searchParams.current = new URLSearchParams(searchParams ?? '');
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectoryFilters plans={PLANS} />
    </NextIntlClientProvider>,
  );
}

describe('active-filter chips', () => {
  it('renders no chip row when no filters are active', () => {
    renderFilters();
    expect(screen.queryByText(/^Status:/)).toBeNull();
    expect(screen.queryByText(/^Plan:/)).toBeNull();
  });

  it('renders a dismissible chip per active filter with the localized label', () => {
    renderFilters('status=active&plan_id=p1&risk_band=at-risk');
    expect(screen.getByText('Status: Active')).toBeInTheDocument();
    expect(screen.getByText('Plan: Premium Corporate')).toBeInTheDocument();
    expect(screen.getByText('Risk: At-risk')).toBeInTheDocument();
  });

  it('clicking a chip × clears ONLY that filter, keeping the others', () => {
    renderFilters('status=active&plan_id=p1');
    fireEvent.click(
      screen.getByRole('button', { name: /remove status: active/i }),
    );
    expect(nav.replaceMock).toHaveBeenCalledTimes(1);
    const url = nav.replaceMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('status=');
    expect(url).toContain('plan_id=p1');
  });

  it('shows a search chip for a text query', () => {
    renderFilters('q=acme');
    expect(screen.getByText('Search: acme')).toBeInTheDocument();
  });

  it('shows the plan year on the plan chip when the list is narrowed to one year', () => {
    renderFilters('plan_id=p1&plan_year=2026');
    expect(screen.getByText('Plan: Premium Corporate (2026)')).toBeInTheDocument();
  });

  it('removing the plan chip clears plan_year with plan_id', () => {
    renderFilters('status=active&plan_id=p1&plan_year=2026');
    fireEvent.click(
      screen.getByRole('button', { name: /remove plan: premium corporate \(2026\)/i }),
    );
    const url = nav.replaceMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('plan_id=');
    expect(url).not.toContain('plan_year=');
    expect(url).toContain('status=active');
  });

  it('clear-all also clears plan_year', () => {
    renderFilters('plan_id=p1&plan_year=2026');
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    const url = nav.replaceMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('plan_year=');
  });

  // 122 US5a (T503) — the bar is AURA FilterBar: the chips are AURA tags in
  // its chips row, the clear-all reads "Clear filters" (the board), and each
  // chip's × is named "Remove <chip>".
  it('renders the filters as an AURA FilterBar with tag chips', () => {
    const { container } = renderFilters('status=active&risk_band=at-risk');
    const bar = container.querySelector('.aura-filterbar');
    expect(bar).not.toBeNull();
    const chips = Array.from(bar!.querySelectorAll('.aura-filterbar__chips .aura-tag')).map(
      (el) => el.textContent,
    );
    expect(chips).toEqual(['Status: Active', 'Risk: At-risk']);
    expect(
      screen.getByRole('button', { name: messages.admin.members.directory.clearFilters }),
    ).toBeInTheDocument();
  });
});

// Whole-branch review: a Clear pressed inside the search debounce must stay
// cleared — the pending typed query must not come back when the timer fires.
describe('clearing inside the search debounce', () => {
  function typedQueriesAfter(clear: () => void) {
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'acme typed' } });
      clear();
      nav.replaceMock.mockClear();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      return nav.replaceMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('q='));
    } finally {
      vi.useRealTimers();
    }
  }

  it('removing the search chip drops the pending typed query', () => {
    renderFilters('q=acme');
    const typed = typedQueriesAfter(() =>
      fireEvent.click(screen.getByRole('button', { name: /remove search: acme/i })),
    );
    expect(typed).toEqual([]);
  });

  it('the lone "Clear filters" (needs-invite only) drops the pending typed query', () => {
    renderFilters('portal=needs_invite');
    // The page's own Clear (outside the bar's chips row, where AURA adds its
    // own once something is typed).
    const typed = typedQueriesAfter(() => {
      const own = screen
        .getAllByRole('button', { name: messages.admin.members.directory.clearFilters })
        .find((b) => !b.closest('.aura-filterbar__chips'));
      fireEvent.click(own!);
    });
    expect(typed).toEqual([]);
  });
});

describe('filter triggers as on the board (US5a)', () => {
  it('each filter is an AURA FilterSelect reading "<name> <value>", named after the filter (#79)', () => {
    const { container } = renderFilters('status=active');
    const face = (name: string) =>
      screen.getByRole('combobox', { name }).closest('.aura-filterselect')?.querySelector('.aura-filterselect__face');
    expect(face('Status')).toHaveTextContent(/^Status\s*Active$/);
    expect(face('Plan')).toHaveTextContent(/^Plan\s*All$/);
    expect(face('Risk band')).toHaveTextContent(/^Risk band\s*All$/);
    expect(container.querySelector('[data-filter-face]')).toBeNull();
  });

  it('the search fills the row through AURA searchGrow (#83), not its classes', () => {
    const { container } = renderFilters();
    const bar = container.querySelector('.aura-filterbar');
    expect(bar).toHaveClass('aura-filterbar--grow');
    expect(bar?.className).not.toContain('[&_.aura-filterbar');
  });
});
