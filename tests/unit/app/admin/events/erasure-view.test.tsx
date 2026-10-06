/**
 * Spec 122 US9b-1 (T925) — the erase-by-email page's view, shared by the page
 * and the no-DB preview route, on AURA (board `Admin-events-erasure`):
 *
 * - the search panel and the results in one AURA card;
 * - the results on an AURA `DataTable` (an ARIA grid; cards on phones);
 * - a pseudonymised row shows "Already erased" and no erase action (FR-032a);
 * - the count stays a polite status; the truncated banner is an AURA warning
 *   alert and the load error an AURA danger alert, both `role="alert"`;
 * - (parity, 6 Oct) the count is visible beside "Erase all", and "Back to
 *   events" is an accent link with a left arrow, shown from `lg` (below it the
 *   shell's back link does the same).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/events/erasure',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderErasureBody } = await import('@/app/(staff)/admin/events/erasure/_components/erasure-view');

const er = en.admin.events.erasure;
const EMAIL = 'ploy.r@gmail.example';
const ROWS = [
  {
    registrationId: 'reg-1',
    eventId: '00000000-0000-4000-8000-000000000001',
    eventName: 'SweCham Crayfish Party 2026',
    dateLabel: '2026-09-05',
    attendeeName: 'Ploy Rattanakul',
    matchType: 'member_contact' as const,
    quota: 'partnership' as const,
    isPseudonymised: false,
  },
  {
    registrationId: 'reg-2',
    eventId: '00000000-0000-4000-8000-000000000002',
    eventName: null,
    dateLabel: null,
    attendeeName: 'Ploy Rattanakul',
    matchType: 'non_member' as const,
    quota: 'none' as const,
    isPseudonymised: true,
  },
];

async function show(ui: Promise<ReactElement>) {
  return render(<NextIntlClientProvider locale="en" messages={en}>{await ui}</NextIntlClientProvider>);
}

describe('erasure view (board Admin-events-erasure)', () => {
  it('lists the matches on an AURA DataTable inside one card, guarding pseudonymised rows', async () => {
    await show(renderErasureBody({ searchedEmail: EMAIL, status: 'results', truncated: false, rows: ROWS }));
    const grid = screen.getByRole('grid');
    expect(grid.closest('.aura-card')).toBe(screen.getByLabelText(er.searchLabel).closest('.aura-card'));
    const [first, second] = within(grid).getAllByRole('row').filter((r) => r.querySelector('[role="gridcell"]'));
    expect(within(first!).getByTestId('erase-pii-button-reg-1')).toBeInTheDocument();
    expect(within(first!).getByRole('link', { name: 'SweCham Crayfish Party 2026' })).toHaveAttribute(
      'href',
      '/admin/events/00000000-0000-4000-8000-000000000001',
    );
    expect(within(second!).getByText(er.pseudonymisedBadge)).toBeInTheDocument();
    expect(within(second!).getByText(er.unknownEvent)).toBeInTheDocument();
    expect(within(second!).queryByTestId('erase-pii-button-reg-2')).toBeNull();
    const status = document.querySelector('output[role="status"]')!;
    expect(status).toHaveTextContent('2 registrations found');
    expect(status).not.toHaveClass('sr-only');
    expect(status.parentElement).toContainElement(screen.getByTestId('erase-all-by-email-button'));
  });

  it('keeps a zero-result count for screen readers only (the quiet line says it)', async () => {
    await show(renderErasureBody({ searchedEmail: EMAIL, status: 'results', truncated: false, rows: [] }));
    const status = document.querySelector('output[role="status"]')!;
    expect(status).toHaveTextContent('No registrations found');
    expect(status).toHaveClass('sr-only');
  });

  it('draws "Back to events" as an accent link with a left arrow, from lg', async () => {
    await show(renderErasureBody({ searchedEmail: '', status: 'idle', truncated: false, rows: [] }));
    const back = screen.getByRole('link', { name: er.backLink });
    expect(back).toHaveAttribute('href', '/admin/events');
    expect(back.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(back).toHaveClass('max-lg:hidden');
    expect(back.className).not.toContain('aura-btn');
  });

  it('shows the truncated banner as an AURA warning alert', async () => {
    await show(renderErasureBody({ searchedEmail: EMAIL, status: 'results', truncated: true, rows: ROWS }));
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(er.truncatedBanner.replace('{cap}', '500'));
    expect(banner.closest('.aura-alert')).not.toBeNull();
  });

  it('shows the load error as an AURA alert and no count', async () => {
    await show(renderErasureBody({ searchedEmail: EMAIL, status: 'error', truncated: false, rows: [] }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(er.errorState);
    expect(alert.closest('.aura-alert')).not.toBeNull();
    expect(document.querySelector('output[role="status"]')).toHaveTextContent('');
  });
});
