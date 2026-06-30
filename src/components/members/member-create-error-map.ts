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
 * The server already reports the offending field — `error.code` for the 409
 * unique-email conflict and `error.details.type` for 400 domain validation
 * (`invalid_email` / `invalid_tax_id` / `invalid_phone` / `invalid_country`).
 * The client previously discarded both and showed a generic
 * "Something went wrong" / "Please fix the highlighted fields" toast with
 * nothing actually highlighted (UAT 2026-06-30). This routes the failure back
 * to the right input so it can be focused + annotated.
 *
 * Returns `null` when the response is not a field-attributable failure (e.g.
 * 403, audit_failed, server_error, or a 400 whose `details.type` we don't map),
 * so the caller can fall back to its generic toast.
 */
export function mapMemberCreateServerError(
  status: number,
  errorCode: string | undefined,
  detailsType: string | undefined,
): MemberServerFieldError | null {
  // 409 — per-tenant case-insensitive unique email on the primary contact
  // (`contacts_tenant_email_uniq`). `soft_duplicate` (company+country) is a
  // separate code handled by its own confirm dialog, so it never reaches here.
  //
  // ASSUMPTION: on the CREATE path the only member/contact unique index that
  // can realistically fire is the primary email — `contacts_one_primary_per_member`
  // cannot trip on a brand-new member and the member-number index is serialised
  // by an advisory lock. (The 409→email mapping itself is pinned by the unit
  // test; this premise rests on the schema + member-number allocator, not the
  // test.) The server's `conflict` is constraint-agnostic (mapDbError →
  // repo.conflict), so IF a member-level unique constraint is ever added (e.g.
  // per-tenant tax_id), revisit this hard-mapping or thread a constraint
  // discriminator from the API.
  if (status === 409 && errorCode === 'conflict') {
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
      default:
        return null;
    }
  }

  return null;
}
