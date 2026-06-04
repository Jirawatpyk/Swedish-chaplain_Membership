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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
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
}: {
  readonly members: readonly MemberOption[];
  readonly plans: readonly PlanOption[];
  readonly events: readonly EventOption[];
  readonly initialMemberId?: string | undefined;
  readonly initialEventId?: string | undefined;
  readonly initialRegistrationId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.new.type');
  // Deep-link wins: an event-registration deep-link starts on the Event tab.
  const [type, setType] = useState<InvoiceType>(
    initialRegistrationId ? 'event' : 'membership',
  );

  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('legend')}</legend>
        <RadioGroup
          value={type}
          onValueChange={(v) => setType(v === 'event' ? 'event' : 'membership')}
          className="gap-3 sm:grid-cols-2"
        >
          <div className="flex items-start gap-2 rounded-md border p-3">
            <RadioGroupItem
              id="invoice-type-membership"
              value="membership"
              className="mt-0.5"
            />
            {/* base-ui Radio auto-wires `aria-labelledby` to `{id}-label`, so
                the name-span carries that id to give the radio its accessible
                name (membership). The hint sits outside the labelledby span. */}
            <Label
              htmlFor="invoice-type-membership"
              className="flex cursor-pointer flex-col gap-0.5"
            >
              <span id="invoice-type-membership-label" className="font-medium">
                {t('membership')}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('membershipHint')}
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-2 rounded-md border p-3">
            <RadioGroupItem id="invoice-type-event" value="event" className="mt-0.5" />
            <Label
              htmlFor="invoice-type-event"
              className="flex cursor-pointer flex-col gap-0.5"
            >
              <span id="invoice-type-event-label" className="font-medium">
                {t('event')}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('eventHint')}
              </span>
            </Label>
          </div>
        </RadioGroup>
      </fieldset>

      {type === 'membership' ? (
        <CreateDraftForm
          members={members}
          plans={plans}
          {...(initialMemberId ? { initialMemberId } : {})}
        />
      ) : (
        <EventFeeForm
          events={events}
          {...(initialEventId ? { initialEventId } : {})}
          {...(initialRegistrationId ? { initialRegistrationId } : {})}
        />
      )}
    </div>
  );
}
