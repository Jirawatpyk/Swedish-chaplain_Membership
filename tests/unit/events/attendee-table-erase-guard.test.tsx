/**
 * DV-6 — AttendeeTable "Erase PII" row-action visibility guard.
 *
 * The erase action reuses the existing <ErasePiiDialog>; the TABLE owns
 * visibility: the trigger shows only when the Actions column shows
 * (`canRelink` + `eventId`) AND the row is NOT already pseudonymised (the
 * deep-link erase page redirects an already-purged registration away, and
 * re-erasure is an idempotent no-op). We assert the TRIGGER button's presence/absence
 * WITHOUT opening the dialog — Base UI AlertDialog deadlocks under jsdom +
 * React 19 startTransition, so the dialog interaction is covered by
 * tests/e2e/erase-attendee.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
vi.mock('sonner', () => ({
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
  it('renders the Erase PII trigger for a non-pseudonymised row when canRelink', () => {
    renderTable([makeRow({ registrationId: 'reg-1' as AttendeeRow['registrationId'] })], true);
    expect(screen.getByTestId('erase-pii-button-reg-1')).toBeInTheDocument();
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
    expect(screen.queryByTestId('erase-pii-button-reg-2')).not.toBeInTheDocument();
  });

  it('does NOT render Erase PII when canRelink is false (manager read-only — no Actions column)', () => {
    renderTable([makeRow({ registrationId: 'reg-3' as AttendeeRow['registrationId'] })], false);
    expect(screen.queryByTestId('erase-pii-button-reg-3')).not.toBeInTheDocument();
  });
});
