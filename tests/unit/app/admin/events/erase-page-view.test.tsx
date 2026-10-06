/**
 * Spec 122 US9b-1 (T927) — the deep-link erase page's body on AURA (board
 * `Admin-event-erase-page`), shared by the page and the preview route: the
 * page header for the attendee, one AURA card holding the hint, the erase
 * trigger and the way back to the event. The page keeps its UUID, permission,
 * not-found and already-erased redirect guards.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/events/e1/registrations/r1/erase',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderErasePageBody } = await import(
  '@/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/_components/erase-page-view'
);

const e = en.admin.events.detail.erase;
const EVENT = '00000000-0000-4000-8000-000000000001';
const REG = '00000000-0000-4000-8000-0000000000aa';

async function show(ui: Promise<ReactElement>) {
  return render(<NextIntlClientProvider locale="en" messages={en}>{await ui}</NextIntlClientProvider>);
}

describe('erase page view (board Admin-event-erase-page)', () => {
  it('puts the hint, the erase trigger and the way back in one AURA card', async () => {
    await show(renderErasePageBody({ eventId: EVENT, registrationId: REG, attendeeName: 'Ploy Rattanakul' }));
    expect(
      screen.getByRole('heading', { level: 1, name: e.pageTitle.replace('{attendeeName}', 'Ploy Rattanakul') }),
    ).toBeInTheDocument();
    const trigger = screen.getByTestId(`erase-pii-button-${REG}`);
    const card = trigger.closest('.aura-card');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(e.pageHint);
    const back = screen.getByRole('link', { name: e.pageBackToEventLabel });
    expect(back).toHaveAttribute('href', `/admin/events/${EVENT}`);
    expect(back.closest('.aura-card')).toBe(card);
  });
});
