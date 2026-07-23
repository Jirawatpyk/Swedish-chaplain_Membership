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
import { render, screen, fireEvent } from '@testing-library/react';
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
});
