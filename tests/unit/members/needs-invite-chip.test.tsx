/**
 * Task 11 (057-members-portal-status) — the needs-invite chip in
 * `<DirectoryFilters>`.
 *
 * Chip visibility rule: rendered when `count > 0` OR the filter is active OR
 * the count is `null` (unavailable). The subtle regression this guards
 * against: turning the filter OFF at count 0 would otherwise unmount the
 * button that was just clicked, dropping focus to `<body>` — a failure axe
 * never catches. `chipWasVisible` keeps the chip mounted for the render it
 * was clicked in.
 *
 * Uses the real `src/i18n/messages/en.json` (not a stub) so a missing key
 * fails this test, per the convention in
 * `tests/unit/members/bundle-change-warning-dialog.test.tsx` /
 * `tests/unit/members/portal-badge.test.tsx`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DirectoryFilters } from '@/components/members/directory-filters';

// Base UI Select (status/risk filters, always rendered) touches PointerEvent
// on render — jsdom lacks it. Same polyfill as
// tests/unit/members/presentation/directory-filters-search-focus.test.tsx.
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

// Mutable navigation state so each test can seed the URL the chip reads
// `?portal=` from, same hoisted-mock shape as
// directory-filters-search-focus.test.tsx.
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

function renderFilters({
  portalInviteCount,
  searchParams,
}: {
  portalInviteCount?: number | null;
  searchParams?: string;
} = {}) {
  nav.searchParams.current = new URLSearchParams(searchParams ?? '');
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {/* exactOptionalPropertyTypes: only spread the prop when the caller
          actually supplied a value — passing `portalInviteCount={undefined}`
          explicitly is not the same as omitting it. */}
      <DirectoryFilters
        {...(portalInviteCount !== undefined ? { portalInviteCount } : {})}
      />
    </NextIntlClientProvider>,
  );
}

describe('needs-invite chip', () => {
  it('exposes a toggle with the count in its accessible name', () => {
    renderFilters({ portalInviteCount: 12 });
    const chip = screen.getByRole('button', {
      name: /needs portal invite, 12 members/i,
    });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('is not rendered when the count is zero and the filter is off', () => {
    renderFilters({ portalInviteCount: 0 });
    expect(
      screen.queryByRole('button', { name: /needs portal invite/i }),
    ).toBeNull();
  });

  it('stays rendered at zero while the filter is active', () => {
    renderFilters({ portalInviteCount: 0, searchParams: 'portal=needs_invite' });
    const chip = screen.getByRole('button', { name: /needs portal invite/i });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders an unavailable state for a null count instead of zero', () => {
    renderFilters({ portalInviteCount: null });
    expect(
      screen.getByRole('button', { name: /portal status unavailable/i }),
    ).toBeDisabled();
  });

  it('shows the Clear button when the chip is the only active filter', () => {
    renderFilters({ portalInviteCount: 3, searchParams: 'portal=needs_invite' });
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('releases once the filter is toggled off at count 0 (latch does not stick)', () => {
    // Regression guard for the OR-clause self-referential latch: the chip was
    // visible (active, count 0), then the user toggles the filter off and the
    // recomputed count is still 0. The chip MUST disappear — nobody needs an
    // invite. The buggy reconcile (`!showChip && chipWasVisible`, a tautology)
    // left it mounted forever once shown; a plain re-mount at inactive+0 can't
    // catch that because `chipWasVisible` initialises false there. Only a
    // visible→toggled-off transition exercises the latch.
    const { rerender } = renderFilters({
      portalInviteCount: 0,
      searchParams: 'portal=needs_invite',
    });
    expect(
      screen.getByRole('button', { name: /needs portal invite/i }),
    ).toBeInTheDocument();

    // Simulate the post-toggle navigation: ?portal= cleared, count still 0.
    nav.searchParams.current = new URLSearchParams('');
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DirectoryFilters portalInviteCount={0} />
      </NextIntlClientProvider>,
    );

    expect(
      screen.queryByRole('button', { name: /needs portal invite/i }),
    ).toBeNull();
  });
});
