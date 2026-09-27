/**
 * Spec 122 US3 (`Portal-timeline` / `Main` boards) — a timeline row names what
 * it is about beside its label: the document number (mono), the event's name,
 * the E-Blast's subject, the fields of a change request; a payment row puts
 * its method on the actor line. The repo supplies these fields
 * (timeline-repo-references.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { TimelineEventItem, type TimelineItemProps } from '@/components/members/timeline-event-item';

const base = { id: 'r', timestamp: '2026-09-15T01:00:00.000Z', actorDisplayName: null } as const;

function show(props: TimelineItemProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      <TimelineEventItem {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<TimelineEventItem> row references', () => {
  afterEach(cleanup);

  it('an invoice row shows its document number in mono', () => {
    show({ ...base, source: 'invoice', eventType: 'issued', actorKind: 'staff', payload: { document_number: 'SC-2026-000123' } });
    expect(screen.getByText('SC-2026-000123')).toHaveClass('font-mono');
  });

  it('a payment row shows the invoice it paid, and its method on the actor line', () => {
    show({ ...base, source: 'payment', eventType: 'succeeded', actorKind: 'member', payload: { document_number: 'SC-2026-000123', payment_method: 'promptpay' } });
    expect(screen.getByText('SC-2026-000123')).toBeInTheDocument();
    expect(screen.getByText(/Member · PromptPay ·/)).toBeInTheDocument();
  });

  it('the compact row keeps the number and leaves the method out', () => {
    show({ ...base, source: 'payment', eventType: 'succeeded', actorKind: 'member', variant: 'compact', payload: { document_number: 'INV-2026-000045', payment_method: 'card' } });
    expect(screen.getByText('INV-2026-000045')).toBeInTheDocument();
    expect(screen.queryByText(/Card/)).toBeNull();
  });

  it('event and E-Blast rows show the name and subject as plain text', () => {
    show({ ...base, source: 'event', eventType: 'attended', actorKind: 'member', payload: { event_name: 'Crayfish Party 2026' } });
    expect(screen.getByText('Crayfish Party 2026')).not.toHaveClass('font-mono');
    cleanup();
    show({ ...base, source: 'broadcast', eventType: 'sent', actorKind: 'member', payload: { broadcast_subject: 'New office on Wireless Road' } });
    expect(screen.getByText('New office on Wireless Road')).not.toHaveClass('font-mono');
  });

  it('a change request names its fields', () => {
    show({
      ...base,
      source: 'audit',
      eventType: 'member_change_request_submitted',
      actorKind: 'member',
      actorUserId: '',
      audience: 'member',
      payload: { field_keys: ['registered_address', 'website'] },
    });
    expect(screen.getByText('Registered address, Website')).toBeInTheDocument();
  });
});

describe('<TimelineEventItem> audit detail face (R9)', () => {
  afterEach(cleanup);

  it('prose details (a company name, a role) are not set in mono; a document number is', () => {
    show({ ...base, source: 'audit', eventType: 'member_created', actorKind: 'staff', actorUserId: '', audience: 'member', payload: { company_name: 'Review Bill Co' } });
    expect(screen.getByText('“Review Bill Co”')).not.toHaveClass('font-mono');
    cleanup();
    show({ ...base, source: 'audit', eventType: 'tax_receipt_issued', actorKind: 'staff', actorUserId: '', audience: 'member', payload: { receipt_document_number_raw: 'RC-2026-000045' } });
    expect(screen.getByText('RC-2026-000045')).toHaveClass('font-mono');
  });
});
