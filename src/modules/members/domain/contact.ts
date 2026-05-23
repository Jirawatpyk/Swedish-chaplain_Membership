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
import { err, ok, type Result } from '@/lib/result';
import type { Email } from './value-objects/email';
import type { Phone } from './value-objects/phone';
import type { UserId } from './value-objects/user-id';
import { isUuid } from './value-objects/uuid';
import type { MemberId, TenantId } from './member';

declare const ContactIdBrand: unique symbol;
export type ContactId = string & { readonly [ContactIdBrand]: true };

/**
 * Brand a raw string as a ContactId. Used at trust boundaries where the
 * value has been validated externally (e.g. returned from the contacts
 * repo, read from URL params after zod parsing). Prefer `tryContactId`
 * for raw untrusted input — ContactIds are UUIDs so a format check is
 * cheap.
 */
export function asContactId(raw: string): ContactId {
  return raw as ContactId;
}

/** Validated ContactId brander for untrusted input. Uses shared UUID regex. */
export function tryContactId(raw: unknown): Result<ContactId, { code: 'invalid_contact_id' }> {
  if (!isUuid(raw)) {
    return err({ code: 'invalid_contact_id' });
  }
  return ok(raw.toLowerCase() as ContactId);
}

export const PREFERRED_LANGUAGES = ['en', 'th', 'sv'] as const;
export type PreferredLanguage = (typeof PREFERRED_LANGUAGES)[number];

/**
 * Primacy sub-shape (M5 review hardening) — encodes the invariant
 * `isPrimary = TRUE ⇒ removedAt IS NULL` so an illegal
 * `{isPrimary:true, removedAt:<date>}` is unrepresentable in any FULL `Contact`
 * value. Mirrors the DB CHECK `contacts_primary_not_removed` (migration 0009).
 * A non-primary contact may be active (removedAt null) or removed (removedAt set).
 *
 * NOTE: like MemberLifecycle, `Omit<Contact, K>` collapses this union, so
 * create-DRAFT types do not enforce the correlation; `contactPrimacy()` + the
 * DB CHECK are the backstops at the construct surface.
 */
export type ContactPrimacy =
  | { readonly isPrimary: true; readonly removedAt: null }
  | { readonly isPrimary: false; readonly removedAt: Date | null };

/**
 * Build the correlated primacy sub-shape from a raw isPrimary + removedAt
 * (e.g. a DB row). The throw is a defensive assertion of the DB CHECK
 * invariant and is unreachable for well-formed rows.
 */
export function contactPrimacy(
  isPrimary: boolean,
  removedAt: Date | null,
): ContactPrimacy {
  if (isPrimary) {
    if (removedAt !== null) {
      throw new Error(
        'contact invariant violated: a primary contact cannot be removed ' +
          '(DB CHECK contacts_primary_not_removed)',
      );
    }
    return { isPrimary: true, removedAt: null };
  }
  return { isPrimary: false, removedAt };
}

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
  readonly dateOfBirth: Date | null;
  readonly linkedUserId: UserId | null;
  /**
   * Spec § Edge Cases — set when the invitation email to this contact
   * bounced (Resend `email.bounced`). NULL = no bounce recorded.
   * Cleared (best-effort) when an admin re-sends the invitation via the
   * `resendBouncedInvite` use-case — in a separate chamber_app tx AFTER
   * the new invitation email is dispatched. If that clear fails the email
   * is still sent and the flag persists until a retry.
   */
  readonly inviteBouncedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} & ContactPrimacy;

export function isPreferredLanguage(
  value: unknown,
): value is PreferredLanguage {
  return (
    typeof value === 'string' &&
    (PREFERRED_LANGUAGES as readonly string[]).includes(value)
  );
}
