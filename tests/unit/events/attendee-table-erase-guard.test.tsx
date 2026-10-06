/**
 * DV-6 — AttendeeTable "Erase personal data" row-action visibility guard.
 *
 * Spec 122 US9b-1 (T923): the action lives in the row's "More" menu
 * (`attendee-more-{rid}`, board `Admin-event-detail`) and opens the existing
 * <ErasePiiDialog>. The TABLE owns visibility: the menu shows only when the
 * Actions column shows (`canRelink` + `eventId`) AND the row is NOT already
 * pseudonymised (the deep-link erase page redirects an already-purged
 * registration away, and re-erasure is an idempotent no-op).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  AttendeeTable,
  type AttendeeRow,
} from '@/components/events/attendee-table';
import { asEventId } from '@/modules/events/domain/branded-types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/events/e1/attendees',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const EVENT_ID = asEventId('00000000-0000-4000-8000-000000000001');

function makeRow(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    registrationId: 'reg-1' as AttendeeRow['registrationId'],
    attendeeEmail: 'a@example.com' as AttendeeRow['attendeeEmail'],
    attendeeName: 'Acme Co',
    attendeeCompany: null,
    matchType: 'non_member',
    ticketType: null,
    ticketPriceThb: null,
    paymentStatus: 'free',
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: false,
    isOverQuota: false,
    registeredAt: '2026-03-20T00:00:00Z',
    currentMatchedMemberId: null,
    isPseudonymised: false,
    ...overrides,
  };
}

function renderTable(rows: readonly AttendeeRow[], canRelink: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AttendeeTable
        rows={rows}
        unmatchedOnly={false}
        initialSearch=""
        eventId={EVENT_ID}
        canRelink={canRelink}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('DV-6 — AttendeeTable Erase PII row action', () => {
  it('offers "Erase personal data" in the row menu for a non-pseudonymised row when canRelink', () => {
    renderTable([makeRow({ registrationId: 'reg-1' as AttendeeRow['registrationId'] })], true);
    fireEvent.click(screen.getByTestId('attendee-more-reg-1'));
    expect(screen.getByRole('menuitem', { name: en.admin.events.detail.attendees.eraseMenuItem })).toBeInTheDocument();
  });

  it('does NOT render Erase PII for an already-pseudonymised row', () => {
    renderTable(
      [
        makeRow({
          registrationId: 'reg-2' as AttendeeRow['registrationId'],
          isPseudonymised: true,
        }),
      ],
      true,
    );
    expect(screen.queryByTestId('attendee-more-reg-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('erase-pii-button-reg-2')).not.toBeInTheDocument();
  });

  it('does NOT render Erase PII when canRelink is false (manager read-only — no Actions column)', () => {
    renderTable([makeRow({ registrationId: 'reg-3' as AttendeeRow['registrationId'] })], false);
    expect(screen.queryByTestId('attendee-more-reg-3')).not.toBeInTheDocument();
  });
});
