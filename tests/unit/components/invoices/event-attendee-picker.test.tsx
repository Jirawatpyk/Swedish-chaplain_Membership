/**
 * Component tests for the event attendee picker
 * (054-event-fee-invoices Task 11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  EventAttendeePicker,
  EventAttendeePickerSkeleton,
  isMatchedMember,
  type AttendeeRow,
} from '@/app/(staff)/admin/invoices/new/_components/event-attendee-picker';

const messages = {
  admin: {
    invoices: {
      eventFeeForm: {
        attendeePicker: {
          label: 'Attendee',
          loading: 'Loading attendees…',
          selectEventFirst: 'Select an event to choose an attendee.',
          matchBadge: {
            matched: 'Matched member',
            nonMember: 'Non-member',
            unmatched: 'Unmatched',
          },
          noPaymentStatus: '—',
          noPrice: 'No fee',
          price: '{amount} THB',
          rowAria: '{name}, {match}, {price}, payment {payment}',
          erasedTooltip: 'This attendee has been erased.',
          empty: {
            none: 'This event has no registered attendees yet.',
            allErased: 'All attendees have been erased.',
          },
        },
      },
    },
  },
};

function row(over: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    registrationId: '11111111-1111-4111-8111-111111111111',
    attendeeName: 'Alice',
    attendeeCompany: 'Acme',
    matchType: 'member_contact',
    matchedMemberId: 'm-1',
    ticketPriceThb: 1000,
    paymentStatus: 'paid',
    isPseudonymised: false,
    ...over,
  };
}

function renderPicker(props: {
  rows: readonly AttendeeRow[];
  selectedRegistrationId?: string | null;
  onSelect?: (r: AttendeeRow) => void;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EventAttendeePicker
        rows={props.rows}
        selectedRegistrationId={props.selectedRegistrationId ?? null}
        onSelect={props.onSelect ?? vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe('isMatchedMember', () => {
  it('true when matchedMemberId is set', () => {
    expect(isMatchedMember(row({ matchedMemberId: 'm-1' }))).toBe(true);
  });
  it('false when matchedMemberId is null', () => {
    expect(isMatchedMember(row({ matchedMemberId: null, matchType: 'non_member' }))).toBe(
      false,
    );
  });
});

describe('<EventAttendeePicker>', () => {
  it('renders one toggle button per attendee with name + match badge + price', () => {
    renderPicker({
      rows: [
        row({ attendeeName: 'Alice', matchedMemberId: 'm-1', matchType: 'member_contact' }),
        row({
          registrationId: '22222222-2222-4222-8222-222222222222',
          attendeeName: 'Bob',
          matchedMemberId: null,
          matchType: 'non_member',
          ticketPriceThb: 2500,
        }),
      ],
    });
    // B3 — plain toggle buttons (NOT an ARIA listbox); no role=option/listbox.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Matched member')).toBeInTheDocument();
    expect(screen.getByText('Non-member')).toBeInTheDocument();
    expect(screen.getByText('1,000 THB')).toBeInTheDocument();
    expect(screen.getByText('2,500 THB')).toBeInTheDocument();
  });

  it('uses aria-labelledby when a labelId is given (S2)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <div>
          <span id="my-label">Attendee</span>
          <EventAttendeePicker
            rows={[row()]}
            selectedRegistrationId={null}
            onSelect={vi.fn()}
            labelId="my-label"
          />
        </div>
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('list')).toHaveAttribute('aria-labelledby', 'my-label');
  });

  it('shows "No fee" for a zero/null ticket price', () => {
    renderPicker({ rows: [row({ ticketPriceThb: null })] });
    expect(screen.getByText('No fee')).toBeInTheDocument();
  });

  it('calls onSelect with the row when clicked', () => {
    const onSelect = vi.fn();
    const r = row({ attendeeName: 'Alice' });
    renderPicker({ rows: [r], onSelect });
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(r);
  });

  it('renders the "none" empty state when there are no rows', () => {
    renderPicker({ rows: [] });
    expect(
      screen.getByText('This event has no registered attendees yet.'),
    ).toBeInTheDocument();
  });

  it('renders the "allErased" empty state when every row is pseudonymised', () => {
    renderPicker({
      rows: [row({ isPseudonymised: true }), row({ isPseudonymised: true })],
    });
    expect(screen.getByText('All attendees have been erased.')).toBeInTheDocument();
  });

  it('renders a pseudonymised row as a non-actionable aria-disabled button with the reason in its accessible name (B1)', () => {
    const onSelect = vi.fn();
    renderPicker({
      rows: [
        row({ attendeeName: 'Alice', isPseudonymised: false }),
        row({
          registrationId: '33333333-3333-4333-8333-333333333333',
          attendeeName: 'Erased',
          isPseudonymised: true,
        }),
      ],
      onSelect,
    });
    // The erased row uses aria-disabled (NOT native disabled), so it stays in
    // the tab order + a11y tree — SR/keyboard/touch users get the reason via
    // the accessible name. It is NOT aria-pressed (not selectable).
    const erased = screen.getByRole('button', { name: /Erased/ });
    expect(erased).toHaveAttribute('aria-disabled', 'true');
    expect(erased).not.toHaveAttribute('aria-pressed');
    expect(erased).toHaveAccessibleName(/This attendee has been erased\./);
    // Activating it must never select (onClick is a hard no-op).
    fireEvent.click(erased);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected row aria-pressed (B3)', () => {
    renderPicker({
      rows: [row({ registrationId: 'sel-id', attendeeName: 'Alice' })],
      selectedRegistrationId: 'sel-id',
    });
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('<EventAttendeePickerSkeleton>', () => {
  it('renders a shimmer placeholder', () => {
    render(<EventAttendeePickerSkeleton />);
    expect(screen.getByTestId('attendee-picker-skeleton')).toBeInTheDocument();
  });
});
