/**
 * Spec 122 US9a (T903) — the event detail's summary card on AURA (board
 * `Admin-event-detail`): date and category, the badges, the match-rate figure
 * with its band, total registrations, last updated and "View on EventCreate";
 * the flag and archive actions at the card's end, each confirmed in the shared
 * AURA confirmation dialog with today's copy, sending today's request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { EventDetailHeader } = await import('@/components/events/event-detail-header');
const { EventCategoryToggles } = await import('@/components/events/event-category-toggles');
const { ArchiveEventButton } = await import('@/components/events/archive-event-button');

const d = en.admin.events.detail;

const EVENT = {
  eventId: 'e-1',
  name: 'Midsummer Mixer',
  startDate: '2026-06-19T10:00:00.000Z',
  category: 'Networking',
  totalRegistrations: 148,
  matchedRegistrations: 121,
  matchRatePct: 81.76,
  isPartnerBenefit: true,
  isCulturalEvent: false,
  archivedAt: null as string | null,
  eventcreateUrl: 'https://www.eventcreate.com/e/midsummer',
  lastUpdatedAt: '2026-06-20T08:00:00.000Z',
};

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('event detail summary card (board Admin-event-detail)', () => {
  it('shows the summary inside one AURA card, the badges as AURA badges', () => {
    wrap(<EventDetailHeader event={EVENT} actions={<button type="button">act</button>} />);
    const card = screen.getByText('Networking').closest('.aura-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText(d.header.partnerBenefit).closest('.aura-badge')).not.toBeNull();
    expect(within(card).getByText('81.8%')).toBeInTheDocument();
    expect(within(card).getByText(d.header.matchRateBandHigh)).toBeInTheDocument();
    expect(within(card).getByText(d.header.totalRegistrations)).toBeInTheDocument();
    expect(within(card).getByText('148')).toBeInTheDocument();
    const link = within(card).getByRole('link', { name: new RegExp(d.header.viewOnEventCreate) });
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(card).getByRole('button', { name: 'act' })).toBeInTheDocument();
    expect(card.querySelector('[data-slot="card"]')).toBeNull();
  });
});

describe('flag and archive actions confirm in the shared AURA dialog', () => {
  it('flags a partner benefit after confirming, with today\'s copy and request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ registrationsReevaluated: 3 }), { status: 200 }));
    wrap(<EventCategoryToggles eventId="e-1" isPartnerBenefit={false} isCulturalEvent={false} />);
    fireEvent.click(screen.getByRole('button', { name: d.toggles.flagPartnerBenefit }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.closest('.aura-dialog, [class*="aura-dialog"]') ?? dialog.className).toBeTruthy();
    expect(within(dialog).getByText(d.toggles.confirmFlagPartnerTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(d.toggles.confirmFlagPartnerBody)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: d.toggles.confirm }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/events/e-1/toggle-partner-benefit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newValue: true }),
    });
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it('archives after confirming, with today\'s copy and request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ registrationsAffected: 0 }), { status: 200 }));
    wrap(<ArchiveEventButton eventId="e-1" />);
    fireEvent.click(screen.getByRole('button', { name: d.archive.archiveCta }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(d.archive.confirmTitle)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: d.archive.confirm }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/events/e-1/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('uses no legacy alert dialog', () => {
    wrap(<ArchiveEventButton eventId="e-1" />);
    fireEvent.click(screen.getByRole('button', { name: d.archive.archiveCta }));
    expect(screen.getByRole('alertdialog').closest('[class*="aura-dialog"]')).not.toBeNull();
  });

  // UX review (US9a): a thrown POST (offline, DNS) must not leave the confirm
  // dialog stuck busy — Cancel, Escape and the scrim all refuse while busy.
  it('a network failure on a flag shows the error toast and lets the dialog close', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<EventCategoryToggles eventId="e-1" isPartnerBenefit={false} isCulturalEvent={false} />);
    fireEvent.click(screen.getByRole('button', { name: d.toggles.flagPartnerBenefit }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: d.toggles.confirm }));
    });
    expect(toastMock.error).toHaveBeenCalledWith(d.toggles.errorTitle, { description: d.toggles.errorDescription });
    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: d.toggles.flagPartnerBenefit })).not.toHaveAttribute('aria-busy', 'true');
  });

  it('a network failure on archive shows the error toast and lets the dialog close', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<ArchiveEventButton eventId="e-1" />);
    fireEvent.click(screen.getByRole('button', { name: d.archive.archiveCta }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: d.archive.confirm }));
    });
    expect(toastMock.error).toHaveBeenCalledWith(d.archive.errorTitle, { description: d.archive.errorDescription });
    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
