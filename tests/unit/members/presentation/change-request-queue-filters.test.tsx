/**
 * F114 US4 — `<ChangeRequestQueueFilters>` (the /admin/change-requests filter bar).
 *
 * The queue used to render a server `<form method="get">` with two native
 * `<select>`s — the one admin surface in the app not on the shadcn `Select`
 * (renewals `tier-filter-select`, broadcasts `queue-filters`, the member-page
 * invoice filters all are). This is the F3 `directory-filters` /
 * `credit-note-filters` shape: URL is the source of truth, controls STAGE
 * locally, the URL is patched on Apply (`router.replace`, scroll kept), and
 * Clear drops every param.
 *
 * `next/navigation` is mocked per `queue-filters-grouping.test.tsx`; the
 * shadcn `Select` is stubbed the way `escalation-task-queue.test.tsx` does it
 * (Base UI's popup does not open in jsdom — options render eagerly here so a
 * click on `role="option"` reaches `onValueChange`).
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ChangeRequestQueueFilters } from '@/app/(staff)/admin/change-requests/_components/queue-filters';

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/change-requests',
  useSearchParams: () => nav.searchParams.current,
}));

vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const SelectCtx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({ value: '', onValueChange: () => {} });
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) =>
      React.createElement(SelectCtx.Provider, { value: { value, onValueChange } }, children),
    SelectTrigger: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) =>
      React.createElement('button', { type: 'button', role: 'combobox', ...rest }, children),
    SelectContent: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange } = React.useContext(SelectCtx);
      return React.createElement('div', { role: 'option', tabIndex: 0, onClick: () => onValueChange(value) }, children);
    },
    TranslatedSelectValue: ({ translate }: { translate: (v: string) => ReactNode }) => {
      const { value } = React.useContext(SelectCtx);
      return React.createElement('span', null, translate(value));
    },
  };
});

const MEMBER = '11111111-1111-4111-8111-111111111111';
const SUBMITTER = '22222222-2222-4222-8222-222222222222';

// a FRESH element per render — RTL's rerender bails out on the same element
function bar() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChangeRequestQueueFilters />
    </NextIntlClientProvider>
  );
}

function renderBar(query = '') {
  nav.searchParams.current = new URLSearchParams(query);
  return render(bar());
}

/** the navigation landed: the URL changed under the SAME instance (no remount) */
function navigateTo(rerender: (ui: React.ReactElement) => void, query: string) {
  nav.searchParams.current = new URLSearchParams(query);
  rerender(bar());
}

beforeEach(() => {
  nav.replaceMock.mockClear();
});

describe('<ChangeRequestQueueFilters>', () => {
  it('renders the state filter as a shadcn Select (combobox) labelled Status, defaulting to the pending view; no outcome control and no Clear on the default view', () => {
    renderBar();
    const state = screen.getByRole('combobox', { name: 'Status' });
    expect(state).toHaveTextContent('Awaiting decision');
    expect(screen.queryByRole('combobox', { name: 'Outcome' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    // no native select anywhere in the bar
    expect(document.querySelector('select')).toBeNull();
  });

  it('shows the outcome Select only once the STAGED state is "decided" (before Apply), and hides it again when the state leaves "decided"', () => {
    renderBar();
    fireEvent.click(screen.getByRole('option', { name: 'Decided' }));
    const outcome = screen.getByRole('combobox', { name: 'Outcome' });
    expect(outcome).toHaveTextContent('Any outcome');
    expect(nav.replaceMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'Withdrawn' }));
    expect(screen.queryByRole('combobox', { name: 'Outcome' })).toBeNull();
  });

  it('leaving "decided" RESETS the staged outcome — a return to "decided" offers "Any outcome" again, never a choice the admin did not re-make (UX L2)', () => {
    renderBar('state=decided&outcome=rejected');
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Not approved');
    fireEvent.click(screen.getByRole('option', { name: 'Withdrawn' }));
    fireEvent.click(screen.getByRole('option', { name: 'Decided' }));
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Any outcome');
  });

  it('the triggers carry their own aria-label (a Base UI trigger is a button — `<label for>` does not name it) and the buttons are never disabled while pending', () => {
    renderBar('state=decided');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAttribute('aria-label', 'Status');
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveAttribute('aria-label', 'Outcome');
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear filters' })).not.toBeDisabled();
  });

  it('Apply writes state + outcome to the URL via router.replace (scroll kept), keeps the member / submitter scoping and drops the cursor', () => {
    renderBar(`memberId=${MEMBER}&submitter=${SUBMITTER}&cursor=abc`);
    fireEvent.click(screen.getByRole('option', { name: 'Decided' }));
    fireEvent.click(screen.getByRole('option', { name: 'Not approved' }));
    fireEvent.change(screen.getByLabelText('Submitted from'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(nav.replaceMock).toHaveBeenCalledTimes(1);
    const [href, opts] = nav.replaceMock.mock.calls[0]!;
    const url = new URL(String(href), 'http://x');
    expect(url.pathname).toBe('/admin/change-requests');
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: 'decided', outcome: 'rejected', memberId: MEMBER, submitter: SUBMITTER, from: '2026-09-01' });
    expect(opts).toEqual({ scroll: false });
  });

  it('an outcome staged under "decided" is NOT written when the state is switched away before Apply; the pending default writes no state param', () => {
    renderBar('state=decided&outcome=rejected');
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Not approved');
    fireEvent.click(screen.getByRole('option', { name: 'Awaiting decision' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(nav.replaceMock).toHaveBeenCalledWith('/admin/change-requests', { scroll: false });
  });

  it('Clear appears once any filter is in the URL and drops every param; once the URL is empty the controls re-stage and focus is still on Apply (UX H1 / N1 — the same instance, never a remount)', () => {
    const { rerender } = renderBar('state=withdrawn&from=2026-01-01&to=2026-02-01');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Withdrawn');
    expect(screen.getByLabelText('Submitted until')).toHaveValue('2026-02-01');
    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    clearButton.focus();
    fireEvent.click(clearButton);
    expect(nav.replaceMock).toHaveBeenCalledWith('/admin/change-requests', { scroll: false });
    const applyButton = screen.getByRole('button', { name: 'Apply' });
    expect(applyButton).toHaveFocus();
    navigateTo(rerender, '');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Awaiting decision');
    expect(screen.getByLabelText('Submitted until')).toHaveValue('');
    // the very same button element — a remount would have dropped focus to <body>
    expect(screen.getByRole('button', { name: 'Apply' })).toBe(applyButton);
    expect(applyButton).toHaveFocus();
  });

  it.each([
    ['a five-digit year', 'to=20260-01-01'],
    ['a non-date', 'from=yesterday'],
  ])('a date the page would refuse (its zod drops the whole query) — %s — is never echoed as a staged filter and surfaces no Clear (UX R1)', (_label, query) => {
    renderBar(query);
    expect(screen.getByLabelText('Submitted from')).toHaveValue('');
    expect(screen.getByLabelText('Submitted until')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('Apply keeps focus on the pressed button across the navigation, and a URL change under the instance (Back / Forward, a chip link) re-stages the controls (UX L1)', () => {
    const { rerender } = renderBar();
    fireEvent.click(screen.getByRole('option', { name: 'Decided' }));
    const applyButton = screen.getByRole('button', { name: 'Apply' });
    applyButton.focus();
    fireEvent.click(applyButton);
    navigateTo(rerender, 'state=decided');
    expect(screen.getByRole('button', { name: 'Apply' })).toBe(applyButton);
    expect(applyButton).toHaveFocus();
    // Back to a different filter set
    navigateTo(rerender, 'state=withdrawn&to=2026-03-31');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Withdrawn');
    expect(screen.queryByRole('combobox', { name: 'Outcome' })).toBeNull();
    expect(screen.getByLabelText('Submitted until')).toHaveValue('2026-03-31');
  });
});
