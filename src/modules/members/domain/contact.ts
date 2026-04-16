/**
 * Contact — child entity of Member.
 *
 * No independent lifecycle (spec § Summary — contacts live and die with
 * their member). Soft-deleted via `removedAt` for audit continuity.
 *
 * Invariants (enforced by `policies/primary-contact-invariant.ts` and
 * the DB partial unique index):
 *   - Exactly one `isPrimary = TRUE` per member while `removedAt IS NULL`
 *     and parent member `status ∈ {active, inactive}`.
 *   - `isPrimary = TRUE ⇒ removedAt IS NULL`.
 *
 * Pure TypeScript — no framework imports.
 */
import type { Email } from './value-objects/email';
import type { Phone } from './value-objects/phone';
import type { UserId } from './value-objects/user-id';
import type { MemberId, TenantId } from './member';

declare const ContactIdBrand: unique symbol;
export type ContactId = string & { readonly [ContactIdBrand]: true };

/** Brand a raw string as a ContactId. Used at trust boundaries. */
export function asContactId(raw: string): ContactId {
  return raw as ContactId;
}

export const PREFERRED_LANGUAGES = ['en', 'th', 'sv'] as const;
export type PreferredLanguage = (typeof PREFERRED_LANGUAGES)[number];

export type Contact = {
  readonly tenantId: TenantId;
  readonly contactId: ContactId;
  readonly memberId: MemberId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: Email;
  readonly phone: Phone | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: PreferredLanguage;
  readonly isPrimary: boolean;
  readonly dateOfBirth: Date | null;
  readonly linkedUserId: UserId | null;
  readonly removedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export function isPreferredLanguage(
  value: unknown,
): value is PreferredLanguage {
  return (
    typeof value === 'string' &&
    (PREFERRED_LANGUAGES as readonly string[]).includes(value)
  );
}
