/**
 * Spec 122 US1 T104 — the staff top bar (`topbar()` on the boards): the
 * search button opens the palette through its window event, the language,
 * colour-scheme and account controls keep their names, and on a phone the
 * colour-scheme choice moves into the account menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { StaffTopBar } from '@/components/layout/staff-top-bar';
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/command-palette/open-event';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';
import { nextCrowded, type RowMeasure } from '@/components/layout/top-bar-crowding';

// jsdom has no layout: the row's measurements come from this stub, and the
// ResizeObserver callback is fired by hand.
const measure = vi.hoisted(() => ({
  next: { wraps: false, rowWidth: 1280, neededWithPill: 600 } as {
    wraps: boolean;
    rowWidth: number;
    neededWithPill: number;
  },
}));
vi.mock('@/components/layout/top-bar-crowding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/layout/top-bar-crowding')>();
  return { ...actual, measureRow: () => measure.next };
});
const observers: Array<() => void> = [];
const observed: Element[] = [];
class StubResizeObserver {
  constructor(private readonly cb: () => void) {
    observers.push(() => this.cb());
  }
  observe(el: Element) {
    observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);
function relayout(next: RowMeasure) {
  measure.next = next;
  act(() => {
    for (const fire of observers) fire();
  });
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BreadcrumbProvider>
        <StaffTopBar
          tenantName="SweCham"
          user={{ displayName: 'Malin Berg', email: 'malin.berg@example.com', role: 'admin' }}
        />
      </BreadcrumbProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

describe('StaffTopBar (spec 122 US1)', () => {
  it('opens the command palette from the search control', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, opened);
    renderBar();
    // The wide control's name is its visible text + the action (WCAG 2.5.3).
    fireEvent.click(screen.getByRole('button', { name: 'Search members, plans, pages… — Open command palette' }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, opened);
  });

  it('keeps the language, colour-scheme and account controls under their names', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /change language/i })).toHaveTextContent('EN');
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Account menu/ })).toBeInTheDocument();
  });

  it('on a phone, offers Light / Dark / System inside the account menu', async () => {
    vi.useRealTimers();
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderBar();
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Account menu/ }));
      expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toBeInTheDocument();
    } finally {
      window.innerWidth = width;
    }
  });
  // Relay R34b: at 200% text on a 393px phone the 44px controls double to 88px,
  // and with the outbox alert showing they no longer fit one row; the row did
  // not wrap, so every admin page ran 67px past the screen (WCAG 1.4.4). The
  // controls wrap onto a second row, kept at the end.
  it('lets its controls wrap to a second row, kept at the end, when one row cannot hold them', () => {
    const { container } = renderBar();
    const row = container.querySelector('div') as HTMLElement;
    expect(row).toContainElement(screen.getByRole('button', { name: /^Account menu/ }));
    expect(row).toHaveClass('flex-wrap', 'justify-end');
  });
  // UX review of PR #530: the brand box may shrink to nothing (min-w-0), so at
  // 200% text the 32px tile (64px) slid under the search button when the
  // controls wrapped. The box keeps the tile's width; the controls wrap instead.
  it('keeps the brand tile\'s width, so wrapped controls never cover it', () => {
    const { container } = renderBar();
    const brandBox = container.querySelector('a[href="/admin"]')!.parentElement as HTMLElement;
    expect(brandBox).toHaveClass('min-w-8', 'sm:min-w-10');
  });

  // PR #530 follow-up: at 393px / 200% text the row wrapped to two rows
  // (~185px, sticky). While the controls cannot fit one row the language pill
  // leaves the bar and the choice moves into the account menu; at normal text
  // size the pill stays.
  it('keeps the language pill in the bar while the row fits', () => {
    const { container } = renderBar();
    relayout({ wraps: false, rowWidth: 345, neededWithPill: 300 });
    expect(container.querySelector('div')).not.toHaveAttribute('data-crowded');
    expect(screen.getByRole('button', { name: /change language/i })).toBeInTheDocument();
  });

  it('moves the language choice into the account menu while the row wraps', async () => {
    vi.useRealTimers();
    const { container } = renderBar();
    relayout({ wraps: true, rowWidth: 337, neededWithPill: 376 });
    expect(container.querySelector('div')).toHaveAttribute('data-crowded', 'true');
    // Out of the tab order, not just visually hidden.
    expect(screen.queryByRole('button', { name: /change language/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Account menu/ }));
    expect(await screen.findByRole('menuitemradio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
  });

  it('brings the pill back only once the row has room for it', () => {
    const { container } = renderBar();
    relayout({ wraps: true, rowWidth: 337, neededWithPill: 376 });
    // Without the pill the row fits: still crowded, or it would flip back and forth.
    relayout({ wraps: false, rowWidth: 337, neededWithPill: 376 });
    expect(container.querySelector('div')).toHaveAttribute('data-crowded', 'true');
    relayout({ wraps: false, rowWidth: 1216, neededWithPill: 376 });
    expect(container.querySelector('div')).not.toHaveAttribute('data-crowded');
    expect(screen.getByRole('button', { name: /change language/i })).toBeInTheDocument();
  });

  // UX review of #547 (M1): the server renders before anything is measured, so
  // at 200% text the bar first drew two rows and then jumped to one. A media
  // query in em (it follows the text size) hides the pill from the first
  // paint; the account menu offers the language under the same query.
  it('hides the pill from the first paint when the text is very large', () => {
    renderBar();
    const pillBox = screen.getByRole('button', { name: /change language/i }).closest('[data-slot="top-bar-locale"]');
    expect(pillBox).toHaveClass('[@media(max-width:14em)]:hidden');
  });

  it('offers the language in the account menu under the same query, before any measurement', async () => {
    vi.useRealTimers();
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === '(max-width: 14em)',
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: /^Account menu/ }));
      expect(await screen.findByRole('menuitemradio', { name: 'Svenska' })).toBeInTheDocument();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  // UX review of #547 (M2): when the pill hides while it has focus (the text
  // is enlarged with focus on it), focus moves to the account menu, which now
  // holds the language, instead of dropping to the page.
  it('moves focus to the account menu when the focused pill hides', () => {
    renderBar();
    screen.getByRole('button', { name: /change language/i }).focus();
    relayout({ wraps: true, rowWidth: 337, neededWithPill: 376 });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Account menu/ }));
  });

  // UX review of #547 (L3): the alert appearing or going does not always
  // resize the row, so each control is observed too.
  it('observes the controls as well as the row', () => {
    observed.length = 0;
    const { container } = renderBar();
    const row = container.querySelector('div');
    const account = screen.getByRole('button', { name: /^Account menu/ });
    expect(observed.some((el) => el !== row && el.contains(account))).toBe(true);
  });
});

describe('nextCrowded', () => {
  it.each([
    ['fits, not crowded', false, { wraps: false, rowWidth: 345, neededWithPill: 300 }, false],
    ['wraps', false, { wraps: true, rowWidth: 337, neededWithPill: 376 }, true],
    ['crowded, fits only without the pill', true, { wraps: false, rowWidth: 337, neededWithPill: 376 }, false],
    ['crowded, room for the pill', true, { wraps: false, rowWidth: 376, neededWithPill: 376 }, true],
    ['crowded and still wrapping', true, { wraps: true, rowWidth: 300, neededWithPill: 376 }, false],
  ] as const)('%s', (_name, wasCrowded, m, uncrowds) => {
    expect(nextCrowded(wasCrowded, m)).toBe(wasCrowded ? !uncrowds : m.wraps);
  });
});
