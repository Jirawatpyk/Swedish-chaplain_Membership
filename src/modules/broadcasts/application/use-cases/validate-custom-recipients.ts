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
 *      c. event_attendees.email (`EventAttendeesRepository.lookupAttendeeEmailInTenant` — F6 bridge: was the email an event attendee in the last 90 days?)
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
/**
 * FR-015d — the one cap on a custom recipient list. Exported (F7-6) so the
 * draft, submit and proxy-submit zod schemas cap the list with the SAME
 * number this classifier checks, rather than a literal that could drift.
 */
export const CUSTOM_RECIPIENTS_MAX_ENTRIES = 100;

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
    }
  // Round-4 MED-B — wrap lookup loop so a transient Neon connection
  // blip doesn't propagate raw Drizzle/SQL details to the route's 500
  // body. Caller maps to `internal_error` envelope.
  | { readonly kind: 'validate_custom.server_error'; readonly message: string };

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

/**
 * The half of the check that needs no tenant graph: the entry count and each
 * entry's RFC-5321 format, in that order. Exported so the draft routes refuse
 * a custom list with exactly the codes and details Submit's check produces
 * (portal live walk U28) instead of re-deriving the rules.
 */
export function checkCustomRecipientEntries(
  emailValidator: EmailValidatorPort,
  raw: ReadonlyArray<string>,
): Result<
  ReadonlyArray<EmailLower>,
  Extract<
    ValidateCustomRecipientsError,
    {
      readonly kind:
        | 'broadcast_custom_recipient_empty'
        | 'broadcast_custom_recipient_too_many'
        | 'broadcast_custom_recipient_invalid_format';
    }
  >
> {
  if (raw.length < MIN_ENTRIES) {
    return err({ kind: 'broadcast_custom_recipient_empty' });
  }
  if (raw.length > CUSTOM_RECIPIENTS_MAX_ENTRIES) {
    return err({
      kind: 'broadcast_custom_recipient_too_many',
      count: raw.length,
      max: CUSTOM_RECIPIENTS_MAX_ENTRIES,
    });
  }

  const invalid: string[] = [];
  const normalised: EmailLower[] = [];
  for (const entry of raw) {
    const validation = emailValidator.validate(entry);
    if (!validation.ok) {
      invalid.push(entry);
      continue;
    }
    normalised.push(unsafeBrandEmailLower(validation.value));
  }
  if (invalid.length > 0) {
    return err({ kind: 'broadcast_custom_recipient_invalid_format', invalid });
  }
  return ok(normalised);
}

export async function validateCustomRecipients(
  deps: ValidateCustomRecipientsDeps,
  input: ValidateCustomRecipientsInput,
): Promise<
  Result<ValidateCustomRecipientsOutput, ValidateCustomRecipientsError>
> {
  const entries = checkCustomRecipientEntries(deps.emailValidator, input.raw);
  if (!entries.ok) return entries;

  // De-duplicate before tenant-graph lookups
  const uniq = Array.from(new Set(entries.value)) as EmailLower[];

  const unresolved: string[] = [];
  try {
    // Round-4 MED-B — sequential per-entry lookups (3 sources × N up
    // to 100). Cost is bounded by `CUSTOM_RECIPIENTS_MAX_ENTRIES`; parallelizing risks
    // saturating the per-tenant DB connection. Wrapped in try/catch
    // so transient infra errors return a typed envelope rather than
    // leaking raw SQL to the response body.
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
  } catch (e) {
    return err({
      kind: 'validate_custom.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }

  if (unresolved.length > 0) {
    return err({ kind: 'broadcast_custom_recipient_unknown', unresolved });
  }

  return ok({ normalised: uniq });
}
