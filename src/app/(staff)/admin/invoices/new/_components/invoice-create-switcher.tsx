/**
 * Task 10 (054-event-fee-invoices) — invoice-type selector + form switch.
 *
 * Top-of-page radiogroup (● Membership ○ Event fee) that toggles between the
 * existing `CreateDraftForm` (membership) and the new `EventFeeForm`. Default
 * is Membership unless a `?eventRegistrationId=` deep-link preselects Event.
 *
 * Admin-only — the parent server page (`new/page.tsx`) already gates on
 * `user.role !== 'admin' → notFound()`; this client component renders only
 * inside that gate.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, RadioGroup } from '@jirawatpyk/aura-react';
import {
  CreateDraftForm,
  type MemberOption,
  type PlanOption,
} from '../../_components/invoice-form';
import { EventFeeForm, type EventOption } from './event-fee-form';

type InvoiceType = 'membership' | 'event';

export function InvoiceCreateSwitcher({
  members,
  plans,
  events,
  initialMemberId,
  initialEventId,
  initialRegistrationId,
  taxAtPayment,
}: {
  readonly members: readonly MemberOption[];
  readonly plans: readonly PlanOption[];
  readonly events: readonly EventOption[];
  readonly initialMemberId?: string | undefined;
  readonly initialEventId?: string | undefined;
  readonly initialRegistrationId?: string | undefined;
  /**
   * 088 (FR-014/SC-005) — when the bill→payment flow is ON, an
   * event-with-TIN `bill_first` document is a non-tax ใบแจ้งหนี้ (the §86/4
   * tax invoice/receipt is minted at payment), so the EventFeeForm preview
   * must not label a pre-payment doc "Tax Invoice". Flag OFF = legacy copy.
   */
  readonly taxAtPayment: boolean;
}) {
  const t = useTranslations('admin.invoices.new.type');
  // Deep-link wins: an event-registration deep-link starts on the Event tab.
  const [type, setType] = useState<InvoiceType>(
    initialRegistrationId ? 'event' : 'membership',
  );

  return (
    <div className="flex flex-col gap-[var(--aura-space-6)]">
      {/* Spec 122 US8 (T807, `Admin-invoice-new`) — the question as the card's
          title, an AURA radio group named "Invoice type" with each option's
          hint as its description, read after the option's name (AURA 5.26,
          handoff #125). */}
      <Card title={t('legend')} headingLevel={2}>
        <RadioGroup
          name="invoice-type"
          label={t('label')}
          orientation="horizontal"
          value={type}
          onChange={(v) => setType(v === 'event' ? 'event' : 'membership')}
          options={[
            { value: 'membership', label: t('membership'), description: t('membershipHint') },
            { value: 'event', label: t('event'), description: t('eventHint') },
          ]}
        />
      </Card>

      {type === 'membership' ? (
        <CreateDraftForm
          members={members}
          plans={plans}
          {...(initialMemberId ? { initialMemberId } : {})}
        />
      ) : (
        <EventFeeForm
          events={events}
          taxAtPayment={taxAtPayment}
          {...(initialEventId ? { initialEventId } : {})}
          {...(initialRegistrationId ? { initialRegistrationId } : {})}
        />
      )}
    </div>
  );
}
