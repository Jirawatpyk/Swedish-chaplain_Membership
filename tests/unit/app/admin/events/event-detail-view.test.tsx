/**
 * Spec 122 US9a (T906) — the event detail page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=event`), so the
 * screenshots show the page itself (board `Admin-event-detail`):
 *
 * - the page header (the event name), the summary card, the attendees list
 *   card titled "Attendees" (h2), and the phone "Event actions" section for a
 *   writer;
 * - the load error in an AURA danger alert, not the legacy destructive box.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { asEventId } from '@/modules/events/domain/branded-types';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/events/e1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/layout/plan-breadcrumb-label', () => ({ DynamicBreadcrumbLabel: () => null }));

const { renderEventDetailView, renderEventDetailError } = await import(
  '@/app/(staff)/admin/events/[eventId]/_components/event-detail-view'
);

const d = en.admin.events.detail;
const EVENT = {
  eventId: asEventId('00000000-0000-4000-8000-000000000001'),
  name: 'SweCham Crayfish Party 2026',
  startDate: '2026-09-05T11:00:00Z',
  category: 'Networking',
  totalRegistrations: 148,
  matchedRegistrations: 121,
  matchRatePct: 81.8,
  isPartnerBenefit: true,
  isCulturalEvent: true,
  archivedAt: null,
  eventcreateUrl: null,
  lastUpdatedAt: '2026-09-24T07:05:00Z',
};

async function show(ui: Promise<ReactElement>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {await ui}
    </NextIntlClientProvider>,
  );
}

describe('event detail view (board Admin-event-detail)', () => {
  it('has the header, the attendees card (h2) and the phone "Event actions" for a writer', async () => {
    await show(
      renderEventDetailView({
        event: EVENT,
        rows: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
        filters: { unmatchedOnly: false, q: null, paymentStatus: null },
        canAct: true,
        canRelink: true,
        canErase: true,
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: EVENT.name })).toBeInTheDocument();
    const attendees = screen.getByRole('heading', { level: 2, name: d.attendees.heading });
    expect(attendees.closest('.aura-card')).not.toBeNull();
    // The phone section (the card's own strip, hidden below 640px, has its sr-only h2 too).
    expect(document.getElementById('event-actions-heading')).toHaveTextContent(d.header.actionsLabel);
  });

  it('shows no "Event actions" to a reader', async () => {
    await show(
      renderEventDetailView({
        event: EVENT,
        rows: [],
        pagination: { page: 1, pageSize: 50, totalCount: 0 },
        filters: { unmatchedOnly: false, q: null, paymentStatus: null },
        canAct: false,
        canRelink: false,
        canErase: false,
      }),
    );
    expect(screen.queryAllByRole('heading', { level: 2, name: d.header.actionsLabel })).toHaveLength(0);
  });

  it('shows the load error in an AURA danger alert', async () => {
    const { container } = await show(renderEventDetailError());
    expect(screen.getByRole('heading', { level: 1, name: d.title })).toBeInTheDocument();
    expect(screen.getByText(d.errorSubtitle)).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(d.errorBody);
    expect(alert.closest('.aura-alert')).not.toBeNull();
    expect(container.querySelector('.border-destructive\\/30')).toBeNull();
  });
});
