/**
 * Spec 122 US4 (whole-branch review M1) — the shared `<InvoiceFilters>`
 * search (member portal + /admin/invoices) on AURA's FilterBar keeps the
 * contract the hand-rolled input had:
 *   - what the member typed is what reaches the URL, so the FilterBar's
 *     URL→draft sync never rewrites the box mid-typing (a trimmed "Acme "
 *     came back as "Acme" and the next keystroke made "AcmeCorp");
 *   - Clear all drops a search still waiting on its debounce and empties
 *     the box, instead of re-applying it 300 ms later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const replace = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
  usePathname: () => '/portal/invoices',
}));

import { InvoiceFilters } from '@/app/(staff)/admin/invoices/_components/invoice-filters';

const tree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <InvoiceFilters />
  </NextIntlClientProvider>
);

const searchBox = () => document.querySelector<HTMLInputElement>('input[type="search"]')!;
const lastUrl = () => replace.mock.calls.at(-1)?.[0] as string | undefined;

beforeEach(() => {
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<InvoiceFilters> search', () => {
  it('a trailing space survives the URL round-trip, so typing carries on', () => {
    const { rerender } = render(tree());
    fireEvent.change(searchBox(), { target: { value: 'Acme ' } });
    act(() => vi.advanceTimersByTime(350));
    expect(lastUrl()).toBeDefined();
    // The router lands the pushed query; the page re-renders with it.
    searchParamsStub = new URLSearchParams(lastUrl()!.split('?')[1] ?? '');
    rerender(tree());
    expect(searchBox().value).toBe('Acme ');
  });

  it('Clear all cancels a pending search and empties the box', () => {
    searchParamsStub = new URLSearchParams('status=paid');
    render(tree());
    fireEvent.change(searchBox(), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: enMessages.admin.invoices.list.filters.clearAll }));
    act(() => vi.advanceTimersByTime(400));
    expect(lastUrl()).toBe('/portal/invoices');
    expect(replace.mock.calls.some(([u]) => String(u).includes('q=abc'))).toBe(false);
    expect(searchBox().value).toBe('');
  });
});
