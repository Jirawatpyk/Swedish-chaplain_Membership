/**
 * Spec 122 US9b-1 (T927) — the deep-link erase page's body on AURA (board
 * `Admin-event-erase-page`), shared by the page and the preview route: the
 * page header for the attendee with the hint as its subtitle, then the erase
 * trigger and the way back to the event — no card, as the board draws it
 * (parity, 6 Oct). The back link is an accent link with a left arrow, from
 * `lg` (below it the shell's "← Event" does the same). The page keeps its
 * UUID, permission, not-found and already-erased redirect guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: nav.refresh }),
  usePathname: () => '/admin/events/e1/registrations/r1/erase',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderErasePageBody } = await import(
  '@/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/_components/erase-page-view'
);

vi.mock('@/lib/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
});

const e = en.admin.events.detail.erase;
const EVENT = '00000000-0000-4000-8000-000000000001';
const REG = '00000000-0000-4000-8000-0000000000aa';

async function show(ui: Promise<ReactElement>) {
  return render(<NextIntlClientProvider locale="en" messages={en}>{await ui}</NextIntlClientProvider>);
}

describe('erase page view (board Admin-event-erase-page)', () => {
  it('puts the hint under the title and the actions under it, with no card', async () => {
    await show(renderErasePageBody({ eventId: EVENT, registrationId: REG, attendeeName: 'Ploy Rattanakul' }));
    const heading = screen.getByRole('heading', { level: 1, name: e.pageTitle.replace('{attendeeName}', 'Ploy Rattanakul') });
    expect(heading.closest('header')).toHaveTextContent(e.pageHint);
    expect(screen.getByTestId(`erase-pii-button-${REG}`)).toBeInTheDocument();
    expect(document.querySelector('.aura-card')).toBeNull();
    const back = screen.getByRole('link', { name: e.pageBackToEventLabel });
    expect(back).toHaveAttribute('href', `/admin/events/${EVENT}`);
    expect(back.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(back).toHaveClass('max-lg:hidden');
  });

  it('opens the erase dialog on arrival and sends the admin back to the event after erasing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ alreadyErased: false, quotaReversals: { partnership: 0, cultural: 0 } }),
        } as Response),
      ),
    );
    await show(renderErasePageBody({ eventId: EVENT, registrationId: REG, attendeeName: 'Ploy Rattanakul' }));
    screen.getByRole('alertdialog', { name: e.confirmTitle.replace('{attendeeName}', 'Ploy Rattanakul') });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${e.reasonLabel}`)), { target: { value: 'PDPA s.33 request' } });
    fireEvent.click(screen.getByRole('button', { name: e.confirm }));
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(nav.push).toHaveBeenCalledWith(`/admin/events/${EVENT}`);
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
