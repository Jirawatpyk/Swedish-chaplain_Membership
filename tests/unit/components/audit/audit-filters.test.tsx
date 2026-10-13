/**
 * Spec 122 US10b (T1011) — the audit filters on AURA's FilterBar, in the one
 * filter pattern: Target record as the bar's search, Event type as a grouped
 * FilterSelect, the acting user in "More filters", From–To as one
 * FilterDateRange, and a chip per applied value. The URL contract is today's:
 * each change replaces `?eventType/actorUserId/targetRef/from/to`, drops the
 * keyset `cursor` and keeps the scroll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const replace = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
  usePathname: () => '/admin/audit',
}));

import { AuditFilters } from '@/components/audit/audit-filters';

const f = enMessages.admin.audit.filters;
const events = enMessages.admin.dashboard.activity.events as Record<string, string>;
const OPTIONS = ['invoice_paid', 'sign_in_succeeded', 'member_created'];

const tree = (resultCount?: number) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <AuditFilters
      eventTypeOptions={OPTIONS}
      timeZone="Asia/Bangkok"
      {...(resultCount !== undefined ? { resultCount } : {})}
    />
  </NextIntlClientProvider>
);

/** AURA's FilterSelect drives a native <select> under its face. */
const nativeSelect = (name: RegExp) =>
  screen.getAllByRole('combobox', { name }).at(-1)!.closest('.aura-select')!.querySelector('select')!;

beforeEach(() => {
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<AuditFilters> on AURA', () => {
  it('is one named filter region whose search is the target record', () => {
    render(tree());
    expect(screen.getByRole('region', { name: f.legend })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: f.target })).toBeInTheDocument();
  });

  it('offers "All event types" then the types grouped by category, as today', () => {
    render(tree());
    const select = nativeSelect(new RegExp(`^${f.eventType}`));
    expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(1);
    expect(within(select).getAllByRole('option', { hidden: true })[0]).toHaveTextContent(f.eventTypeAll);
  });

  it('an event-type pick replaces the URL, dropping the cursor, keeping the scroll', () => {
    searchParamsStub = new URLSearchParams('from=2026-09-01&cursor=abc');
    render(tree());
    fireEvent.change(nativeSelect(new RegExp(`^${f.eventType}`)), { target: { value: 'invoice_paid' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/audit?from=2026-09-01&eventType=invoice_paid', { scroll: false });
  });

  it('"All event types" removes the parameter', () => {
    searchParamsStub = new URLSearchParams('eventType=invoice_paid');
    render(tree());
    fireEvent.change(nativeSelect(new RegExp(`^${f.eventType}`)), { target: { value: 'all' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/audit', { scroll: false });
  });

  it('the target search commits after the debounce, dropping the cursor', () => {
    searchParamsStub = new URLSearchParams('cursor=abc');
    render(tree());
    fireEvent.change(screen.getByRole('searchbox', { name: f.target }), { target: { value: 'SC-2026-000131' } });
    expect(replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/audit?targetRef=SC-2026-000131', { scroll: false });
  });

  it('the acting user, under "More filters", commits trimmed after the debounce', () => {
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${f.moreFilters}`) }));
    const actor = screen.getByRole('textbox', { name: f.actor });
    fireEvent.change(actor, { target: { value: ' 8b21-77c0 ' } });
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/audit?actorUserId=8b21-77c0', { scroll: false });
  });

  it('shows each applied filter as a chip; removing one drops only that parameter', () => {
    searchParamsStub = new URLSearchParams('eventType=invoice_paid&actorUserId=u-1&targetRef=t-9&from=2026-09-01&to=2026-09-10');
    render(tree());
    const remove = (label: string) =>
      screen.getByRole('button', { name: f.removeChip.replace('{label}', label) });
    expect(remove(f.chip.replace('{label}', f.eventType).replace('{value}', events.invoice_paid ?? 'Invoice paid'))).toBeInTheDocument();
    fireEvent.click(remove(f.chip.replace('{label}', f.actor).replace('{value}', 'u-1')));
    expect(replace).toHaveBeenLastCalledWith(
      '/admin/audit?eventType=invoice_paid&targetRef=t-9&from=2026-09-01&to=2026-09-10',
      { scroll: false },
    );
  });

  it('removing the date chip drops both ends of the range', () => {
    searchParamsStub = new URLSearchParams('from=2026-09-01&to=2026-09-10&eventType=invoice_paid');
    render(tree());
    const chip = screen.getAllByRole('button', { name: new RegExp(`^${f.removeChip.replace('{label}', f.date)}`) })[0]!;
    fireEvent.click(chip);
    expect(replace).toHaveBeenLastCalledWith('/admin/audit?eventType=invoice_paid', { scroll: false });
  });

  it('"Clear filters" drops every filter at once', () => {
    searchParamsStub = new URLSearchParams('eventType=invoice_paid&targetRef=t-9&cursor=abc');
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: f.clear }));
    expect(replace).toHaveBeenLastCalledWith('/admin/audit', { scroll: false });
  });

  it('shows the count of matching events at the end of the row', () => {
    render(tree(5));
    expect(screen.getByText('5 audit events')).toBeInTheDocument();
  });

  it('gives "More filters" a 44px box on phones', () => {
    render(tree());
    expect(screen.getByRole('button', { name: new RegExp(`^${f.moreFilters}`) })).toHaveClass('aura-btn--touch');
  });
});
