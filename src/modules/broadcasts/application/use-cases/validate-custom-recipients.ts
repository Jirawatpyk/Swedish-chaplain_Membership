/**
 * T065 — `validate-custom-recipients.ts` Application use-case (F7).
 *
 * FR-015d / Q9 — every entry in a custom recipient list MUST resolve to
 * an email known to the tenant graph (members.primary_contact_email OR
 * contacts.email OR event_attendees.email). Prevents the chamber's
 * sender reputation being used to broadcast to arbitrary external lists.
 *
 * Pipeline per email:
 *   1. RFC-5321 format check via `EmailValidatorPort.validate`
 *   2. Lowercase + trim normalisation (already done by validator)
 *   3. Three-source resolution:
 *      a. members.primary_contact_email (`MembersBridgePort.lookupMemberPrimaryContactEmailInTenant`)
 *      b. contacts.email (`MembersBridgePort.lookupContactEmailInTenant`)
 *      c. event_attendees.email (`EventAttendeesRepository.lookupAttendeeEmailInTenant` — F6 stub returns null)
 *   4. If all 3 unresolved → push to `unresolved[]`
 *
 * Constraints: 1 ≤ N ≤ 100 entries (FR-015d).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { EmailValidatorPort } from '../ports/email-validator-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';

const MIN_ENTRIES = 1;
const MAX_ENTRIES = 100;

export type ValidateCustomRecipientsError =
  | { readonly kind: 'broadcast_custom_recipient_empty' }
  | {
      readonly kind: 'broadcast_custom_recipient_too_many';
      readonly count: number;
      readonly max: 100;
    }
  | {
      readonly kind: 'broadcast_custom_recipient_invalid_format';
      readonly invalid: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'broadcast_custom_recipient_unknown';
      readonly unresolved: ReadonlyArray<string>;
    };

export interface ValidateCustomRecipientsDeps {
  readonly tenant: TenantContext;
  readonly emailValidator: EmailValidatorPort;
  readonly membersBridge: MembersBridgePort;
  readonly eventAttendees: EventAttendeesRepository;
}

export interface ValidateCustomRecipientsInput {
  readonly raw: ReadonlyArray<string>;
}

export interface ValidateCustomRecipientsOutput {
  readonly normalised: ReadonlyArray<EmailLower>;
}

export async function validateCustomRecipients(
  deps: ValidateCustomRecipientsDeps,
  input: ValidateCustomRecipientsInput,
): Promise<
  Result<ValidateCustomRecipientsOutput, ValidateCustomRecipientsError>
> {
  if (input.raw.length < MIN_ENTRIES) {
    return err({ kind: 'broadcast_custom_recipient_empty' });
  }
  if (input.raw.length > MAX_ENTRIES) {
    return err({
      kind: 'broadcast_custom_recipient_too_many',
      count: input.raw.length,
      max: MAX_ENTRIES,
    });
  }

  const invalid: string[] = [];
  const normalised: EmailLower[] = [];
  for (const raw of input.raw) {
    const validation = deps.emailValidator.validate(raw);
    if (!validation.ok) {
      invalid.push(raw);
      continue;
    }
    normalised.push(unsafeBrandEmailLower(validation.value));
  }
  if (invalid.length > 0) {
    return err({ kind: 'broadcast_custom_recipient_invalid_format', invalid });
  }

  // De-duplicate before tenant-graph lookups
  const uniq = Array.from(new Set(normalised)) as EmailLower[];

  const unresolved: string[] = [];
  for (const email of uniq) {
    const memberPrimary =
      await deps.membersBridge.lookupMemberPrimaryContactEmailInTenant(
        deps.tenant,
        email,
      );
    if (memberPrimary !== null) continue;

    const contact = await deps.membersBridge.lookupContactEmailInTenant(
      deps.tenant,
      email,
    );
    if (contact !== null) continue;

    const attendee = await deps.eventAttendees.lookupAttendeeEmailInTenant(
      deps.tenant,
      email,
    );
    if (attendee !== null) continue;

    unresolved.push(email);
  }

  if (unresolved.length > 0) {
    return err({ kind: 'broadcast_custom_recipient_unknown', unresolved });
  }

  return ok({ normalised: uniq });
}
