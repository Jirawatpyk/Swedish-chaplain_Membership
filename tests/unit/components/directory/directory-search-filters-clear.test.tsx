/**
 * 122 US5a (whole-branch review) — the staff directory's Clear pressed inside
 * the search debounce stays cleared: AURA's FilterBar keeps the typed text and
 * its own timer, so the pending query must not come back when the timer fires.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DirectorySearchFilters } from '@/components/directory/directory-search-filters';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/admin/directory',
  useSearchParams: () => new URLSearchParams('listed=true'),
}));

describe('directory search — Clear inside the debounce', () => {
  it('drops the pending typed query', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DirectorySearchFilters />
      </NextIntlClientProvider>,
    );
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nordic' } });
      fireEvent.click(screen.getByRole('button', { name: messages.admin.directory.search.clear }));
      nav.replace.mockClear();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(nav.replace.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('q='))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
