/**
 * Spec 122 US9c (T945) — recent deliveries on AURA (board
 * `Admin-eventcreate`; Clarifications 2026-10-09, US9c start).
 *
 * - signature is an AURA `StatusPill` by outcome: verified → ready,
 *   rejected → blocked, unknown → neutral (exposed as `data-tone`);
 * - processing is plain text, as on the board;
 * - the table keeps its caption and the request ID cut to 12 characters;
 * - the "Include test deliveries" switch keeps its name, and toggling it
 *   only changes the URL (FR-011);
 * - no rows: the existing empty text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { RecentDelivery } from '@/lib/events-admin-integration-types';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: nav.refresh }),
  usePathname: () => '/admin/settings/integrations/eventcreate',
  useSearchParams: () => new URLSearchParams(),
}));

const { RecentDeliveriesPanel } = await import('@/components/events/recent-deliveries-panel');

const r = en.admin.integrations.eventcreate.phaseC.recentDeliveries;

function row(over: Partial<RecentDelivery>): RecentDelivery {
  return {
    receivedAt: '2026-10-09T01:00:00.000Z',
    requestId: 'req_8f3a1c9e00112233',
    signatureOutcome: 'verified',
    processingOutcome: 'matched_member_contact',
    matchedMemberId: null,
    registrationId: null,
    ...over,
  };
}

const ROWS: RecentDelivery[] = [
  row({}),
  row({ requestId: 'req_5e11f8d7aa', signatureOutcome: 'rejected', processingOutcome: null }),
  row({ requestId: 'req_00000000zz', signatureOutcome: 'unknown', processingOutcome: 'non_member' }),
];

function renderPanel(deliveries: RecentDelivery[] = ROWS, includeTestDeliveries = false) {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      <RecentDeliveriesPanel deliveries={deliveries} includeTestDeliveries={includeTestDeliveries} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<RecentDeliveriesPanel> on AURA', () => {
  it('shows signature as a status pill toned by outcome', () => {
    renderPanel();
    expect(screen.getAllByText(r.signature.verified)[0]).toHaveAttribute('data-tone', 'ready');
    expect(screen.getAllByText(r.signature.rejected)[0]).toHaveAttribute('data-tone', 'blocked');
    expect(screen.getAllByText(r.signature.unknown)[0]).toHaveAttribute('data-tone', 'neutral');
  });

  it('shows processing as plain text, and keeps the caption and the cut request ID', () => {
    renderPanel();
    const processing = screen.getAllByText(r.processing.matched_member_contact)[0]!;
    expect(processing.closest('[data-tone]')).toBeNull();
    expect(screen.getByRole('table', { name: r.table.caption })).toBeInTheDocument();
    expect(screen.getAllByText('req_8f3a1c9e…').length).toBeGreaterThan(0);
  });

  it('keeps the switch name, and toggling it only changes the URL', async () => {
    renderPanel();
    const toggle = screen.getByRole('switch', { name: r.includeTestDeliveriesLabel });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(String(nav.replace.mock.calls[0]?.[0])).toMatch(/\?includeTestDeliveries=true$/);
  });

  it('shows the empty text when there are no rows', () => {
    renderPanel([]);
    expect(screen.getByText(r.empty)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
