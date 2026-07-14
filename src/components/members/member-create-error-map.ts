import type { Path } from 'react-hook-form';
import type { MemberFormValues } from './member-form';

/**
 * A server-rejected member-create field, routed back to the react-hook-form
 * field path that produced it plus the i18n key (relative to the
 * `admin.members.create` namespace) describing what to fix.
 */
export type MemberServerFieldError = {
  readonly field: Path<MemberFormValues>;
  readonly messageKey: string;
};

/**
 * Map a failed `POST /api/members` response to the specific form field that
 * caused it.
 *
 * The server already reports the offending field — `error.details.reason`
 * for the 409 conflict and `error.details.type` for 400 domain validation
 * (`invalid_email` / `invalid_tax_id` / `invalid_phone` / `invalid_country`
 * / the PR-B task 8 secondary-contact variants). The client previously
 * discarded all of this and showed a generic "Something went wrong" /
 * "Please fix the highlighted fields" toast with nothing actually
 * highlighted (UAT 2026-06-30). This routes the failure back to the right
 * input so it can be focused + annotated.
 *
 * Returns `null` when the response is not a field-attributable failure (e.g.
 * 403, audit_failed, server_error, or a 400 whose `details.type` we don't map),
 * so the caller can fall back to its generic toast.
 */
export function mapMemberCreateServerError(
  status: number,
  errorCode: string | undefined,
  detailsType: string | undefined,
  // PR-B task 8 — `error.details.reason` on a 409 `conflict`. Optional +
  // last so every pre-existing 3-arg call site keeps compiling unchanged.
  conflictReason?: string,
): MemberServerFieldError | null {
  // 409 — a unique-index violation somewhere on the create path.
  // `soft_duplicate` (company+country) is a separate code handled by its
  // own confirm dialog, so it never reaches here.
  //
  // PR-B task 8 — `contacts_tenant_email_uniq` is per-tenant on
  // `lower(email)`, so a collision can now come from EITHER the primary
  // OR the secondary contact's email (previously only the primary contact
  // could realistically collide — `contacts_one_primary_per_member` can't
  // trip on a brand-new member and the member-number index is serialised
  // by an advisory lock). The server discriminates via
  // `createWithPrimaryContactInTx`'s per-insert `RepoConflictReason` and
  // threads it through `route.ts`'s `details.reason`; switch on it here so
  // ONLY a genuine secondary-email collision highlights the secondary
  // field. Every other reason (`primary_email_in_use`, the near-unreachable
  // `member_duplicate`, or an absent/unrecognised value — e.g. a future
  // member-level unique constraint added without a case here) falls back to
  // the primary contact's email: the safest default, since that is still
  // the overwhelming majority of create-time conflicts.
  if (status === 409 && errorCode === 'conflict') {
    if (conflictReason === 'secondary_email_in_use') {
      return {
        field: 'secondary_contact.email',
        messageKey: 'errors.secondaryEmailInUse',
      };
    }
    return { field: 'primary_contact.email', messageKey: 'errors.emailInUse' };
  }

  // 400 — value-object validation in the create use-case. `details.type` names
  // the failing value object.
  if (status === 400) {
    switch (detailsType) {
      case 'invalid_email':
        return {
          field: 'primary_contact.email',
          messageKey: 'fields.errors.emailFormat',
        };
      case 'invalid_tax_id':
        return { field: 'tax_id', messageKey: 'errors.taxIdInvalid' };
      case 'invalid_phone':
        return { field: 'primary_contact.phone', messageKey: 'fields.phoneError' };
      case 'invalid_country':
        return { field: 'country', messageKey: 'fields.errors.countryCode' };
      // PR-B task 8 — secondary-contact domain validation.
      case 'invalid_secondary_email':
        return {
          field: 'secondary_contact.email',
          messageKey: 'fields.errors.emailFormat',
        };
      case 'invalid_secondary_phone':
        return {
          field: 'secondary_contact.phone',
          messageKey: 'fields.phoneError',
        };
      // Defense-in-depth only — the client zod schema blocks this before
      // submit (see member-form/schema.ts's superRefine), so this case is
      // reachable only via a direct API call that bypasses the form.
      case 'secondary_email_same_as_primary':
        return {
          field: 'secondary_contact.email',
          messageKey: 'fields.errors.secondaryEmailSameAsPrimary',
        };
      default:
        return null;
    }
  }

  return null;
}
